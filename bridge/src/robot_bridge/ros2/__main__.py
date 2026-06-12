"""rclpy bridge entrypoint — live-tested against the 2D stack (2026-06-11);
Nav2 goal sending not yet exercised on hardware.

Run on the Jetson with the ROS2 Humble environment sourced (or via
./start_bridge.sh, which does all of this):

    source /opt/ros/humble/setup.bash
    # 3D stack (FAST-LIO2 + RTABMap):
    python -m robot_bridge.ros2 --stack 3d
    # 2D stack (slam_toolbox / start_explore_2d.sh):
    python -m robot_bridge.ros2 --stack 2d

Stack presets (override individually with --scan-topic/--odom-topic/--map-topic;
pass an empty string to disable a subscription):

    3d: scan=/cloud_registered (world frame), odom=/Odometry, map=/map (RTABMap)
    2d: scan disabled (no world-frame cloud), odom=/odom (rf2o), map=/map (slam_toolbox)

Architecture: rclpy spins in a background thread; the asyncio WebSocket server
runs in the main thread. ROS callbacks hand frames to the asyncio loop via
loop.call_soon_threadsafe; asyncio hands work (nav goals) to the ROS thread via
a job queue drained by a 20 Hz ROS timer.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import math
import queue
import threading
import time

from .. import protocol
from ..mapacc import MapAccumulator
from ..mjpeg import MjpegServer
from ..server import BridgeServer, Client
from .converters import (
    laserscan_to_xyzi,
    occupancygrid_to_grid,
    odometry_to_pose,
    pointcloud2_to_xyzi,
    stamp_to_seconds,
    transform_xyzi,
)

log = logging.getLogger("robot_bridge.ros2")

# Topic presets per slam_bringup stack. The wire protocol requires scan points
# in the map frame; the bridge TF-transforms any cloud whose header.frame_id
# isn't "map" (2d: /livox/lidar arrives in the lidar body frame and rides
# map->odom->base_link->livox TF; 3d: /cloud_registered arrives in FAST-LIO2's
# camera_init odom frame and rides RTABMap's map->camera_init correction).
STACK_PRESETS = {
    "3d": {"scan": "/cloud_registered", "odom": "/Odometry", "map": "/map"},
    "2d": {"scan": "/livox/lidar", "odom": "/odom", "map": "/map"},
}

NAV_ACTION = "navigate_to_pose"
NAV_FEEDBACK_MIN_INTERVAL = 0.5  # rate-limit nav_status to 2 Hz


class Ros2Bridge:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        channels = ["pose", "occupancy_grid", "stats", "log", "nav_status",
                    "nav_path", "velocity", "imu", "mission"]
        if args.scan_topic:
            channels += ["scan", "map"]
        if args.detections_topic:
            channels.append("objects")
        self.mapacc = MapAccumulator(voxel_size=args.map_voxel)
        # semantic object memory: cluster detections by label+position
        self.objects: list[dict] = []
        self._latest_jpeg: bytes | None = None
        self.cameras: dict[str, str] = {}  # stream name -> Image topic (1-4)
        if args.camera:
            for spec in args.camera[:4]:
                name, _, topic = spec.partition("=")
                if topic:
                    self.cameras[name] = topic
        elif args.camera_topic:
            self.cameras["rgb"] = args.camera_topic
        self.server = BridgeServer(
            server_name=args.name, channels=channels, app_version="0.1.0",
            command_handler=self.on_command,
            cameras=list(self.cameras) if args.mjpeg_port else [])
        self.loop: asyncio.AbstractEventLoop | None = None

        # live stats (written by ROS thread, read by asyncio stats loop — plain
        # attributes are fine under the GIL)
        self.t0 = time.time()
        self.distance_m = 0.0
        self.last_xy: tuple[float, float] | None = None
        self.map_updates = 0
        self.map_known_m2 = 0.0
        self.scan_frames = 0
        self.total_pts = 0
        self._scan_frames_last = 0

        # velocity comparison (smear detector food): latest commanded and
        # measured body velocities, written by ROS callbacks
        self.cmd_vel = (0.0, 0.0)   # vx, wz
        self.cmd_vel_t = 0.0        # monotonic stamp; cmd decays to 0 when stale
        self.odom_vel = (0.0, 0.0)
        self._tf_buffer = None
        self._tf_warned = False
        self._bench_mode = False  # true while scans render untransformed (no TF)

        # camera
        self.mjpeg = MjpegServer(fps=10.0) if args.mjpeg_port else None
        self._last_jpeg_t: dict[str, float] = {}
        self._last_imu_t = 0.0

        # nav state
        self._ros_jobs: queue.Queue = queue.Queue()
        self._nav_client = None          # rclpy ActionClient (ROS thread only)
        self._nav_goal_type = None       # NavigateToPose (ROS thread only)
        self._node = None
        self._goal_handle = None         # current rclpy goal handle (ROS thread only)
        self._goal_seq = 0
        self._active_goal_id: str | None = None
        self._last_feedback = 0.0

    # -- ROS side (background thread) ---------------------------------------

    def ros_thread(self) -> None:
        import rclpy  # lazy: only the Jetson has this
        from nav_msgs.msg import OccupancyGrid, Odometry
        from sensor_msgs.msg import PointCloud2

        rclpy.init()
        node = rclpy.create_node("viewer_bridge")
        self._node = node
        subscribed = []
        if self.args.scan_topic:
            if self.args.scan_msg == "laserscan":
                from sensor_msgs.msg import LaserScan
                node.create_subscription(LaserScan, self.args.scan_topic,
                                         self.on_laserscan, 10)
            else:
                node.create_subscription(PointCloud2, self.args.scan_topic,
                                         self.on_scan, 10)
            subscribed.append(self.args.scan_topic)
        if self.args.odom_topic:
            node.create_subscription(Odometry, self.args.odom_topic, self.on_odom, 50)
            subscribed.append(self.args.odom_topic)
        # slam_toolbox and Nav2 costmaps publish transient-local; match that QoS
        from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
        map_qos = QoSProfile(
            depth=1,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.TRANSIENT_LOCAL)
        if self.args.map_topic:
            node.create_subscription(OccupancyGrid, self.args.map_topic,
                                     self.on_map, map_qos)
            subscribed.append(self.args.map_topic)
        if self.args.global_costmap_topic:
            node.create_subscription(
                OccupancyGrid, self.args.global_costmap_topic,
                lambda msg: self.on_costmap(msg, "costmap_global"), map_qos)
            subscribed.append(self.args.global_costmap_topic)
        if self.args.local_costmap_topic:
            node.create_subscription(
                OccupancyGrid, self.args.local_costmap_topic,
                lambda msg: self.on_costmap(msg, "costmap_local"), map_qos)
            subscribed.append(self.args.local_costmap_topic)
        if self.args.plan_topic:
            from nav_msgs.msg import Path
            node.create_subscription(Path, self.args.plan_topic, self.on_plan, 10)
            subscribed.append(self.args.plan_topic)
        if self.args.cmd_vel_topic:
            from geometry_msgs.msg import Twist
            node.create_subscription(Twist, self.args.cmd_vel_topic,
                                     self.on_cmd_vel, 10)
            subscribed.append(self.args.cmd_vel_topic)
        if self.args.mission_topic:
            from std_msgs.msg import String
            node.create_subscription(String, self.args.mission_topic,
                                     self.on_mission, 10)
            subscribed.append(self.args.mission_topic)
        if self.args.detections_topic:
            try:
                from vision_msgs.msg import Detection3DArray
                node.create_subscription(Detection3DArray, self.args.detections_topic,
                                         self.on_detections, 10)
                subscribed.append(self.args.detections_topic)
            except ImportError:
                log.warning("vision_msgs not available — object mapping disabled")
        if self.args.imu_topic:
            from sensor_msgs.msg import Imu
            from rclpy.qos import qos_profile_sensor_data
            node.create_subscription(Imu, self.args.imu_topic, self.on_imu,
                                     qos_profile_sensor_data)
            subscribed.append(self.args.imu_topic)
        if self.mjpeg is not None and self.cameras:
            from sensor_msgs.msg import Image
            from rclpy.qos import qos_profile_sensor_data
            for name, topic in self.cameras.items():
                node.create_subscription(
                    Image, topic,
                    lambda msg, n=name: self.on_image(msg, n),
                    qos_profile_sensor_data)
                subscribed.append(f"{topic} (cam:{name})")

        # TF listener: local costmap origins arrive in the odom frame and must
        # be re-expressed in map (the wire protocol's only frame)
        from tf2_ros import Buffer, TransformListener
        self._tf_buffer = Buffer()
        TransformListener(self._tf_buffer, node)

        try:
            from nav2_msgs.action import NavigateToPose
            from rclpy.action import ActionClient
            self._nav_client = ActionClient(node, NavigateToPose, NAV_ACTION)
            self._nav_goal_type = NavigateToPose
            subscribed.append(f"action:{NAV_ACTION}")
        except ImportError:
            log.warning("nav2_msgs not available — goal sending disabled")

        # drain asyncio -> ROS jobs (nav goal send/cancel) at 20 Hz
        node.create_timer(0.05, self._drain_jobs)

        log.info("rclpy spinning: %s", ", ".join(subscribed))
        self.log_clients("info", f"bridge up: {', '.join(subscribed)}")
        rclpy.spin(node)

    def _drain_jobs(self) -> None:
        while True:
            try:
                job = self._ros_jobs.get_nowait()
            except queue.Empty:
                return
            try:
                job()
            except Exception:  # noqa: BLE001 — a bad job must not kill the timer
                log.exception("nav job failed")

    def _post(self, topic: str, data, ts: float | None = None) -> None:
        """Hand a frame from any thread to the asyncio loop."""
        if self.loop is not None:
            self.loop.call_soon_threadsafe(
                self.server.broadcast, topic, data, ts if ts is not None else time.time())

    def log_clients(self, level: str, message: str) -> None:
        self._post(protocol.CH_LOG, protocol.log_payload(level, message))

    def on_scan(self, msg) -> None:
        xyzi = pointcloud2_to_xyzi(msg, decimate=self.args.decimate,
                                   intensity_scale=self.args.intensity_scale)
        self._publish_scan(xyzi, msg.header)

    def on_laserscan(self, msg) -> None:
        self._publish_scan(laserscan_to_xyzi(msg), msg.header)

    def _publish_scan(self, xyzi, header) -> None:
        frame = header.frame_id
        transformed = True
        if frame and frame != "map":
            tq = self._lookup_map_tf(frame)
            if tq is None:
                # BENCH MODE: no TF chain (sensor running without SLAM) —
                # show the live cloud in the raw sensor frame at the origin
                # instead of dropping it. Map accumulation stays off so wrong-
                # frame points never get baked into the accumulated map.
                transformed = False
                if not self._bench_mode:
                    self._bench_mode = True
                    log.info("no map->%s TF — bench mode: live scan in sensor frame, "
                             "map accumulation paused", frame)
                    self.log_clients("warn", "bench mode: no TF to map — showing raw "
                                             "sensor frame (start SLAM for mapping)")
            else:
                xyzi = transform_xyzi(xyzi, *tq)
                if self._bench_mode:
                    self._bench_mode = False
                    log.info("map->%s TF available — leaving bench mode", frame)
                    self.log_clients("info", "TF chain up — map-frame rendering and "
                                             "map accumulation active")
        self.scan_frames += 1
        self.total_pts += len(xyzi)
        ts = stamp_to_seconds(header.stamp)
        self._post(protocol.CH_SCAN, protocol.pack_scan(xyzi), ts)
        if transformed:
            delta = self.mapacc.add_scan(xyzi)
            if delta is not None:
                self._post(protocol.CH_MAP, protocol.pack_scan(delta), ts)

    def _lookup_map_tf(self, frame: str):
        """Latest map<-frame transform as ((x,y,z), (qx,qy,qz,qw)), or None."""
        try:
            import rclpy.time
            t = self._tf_buffer.lookup_transform("map", frame, rclpy.time.Time())
        except Exception:  # noqa: BLE001 — tf2 raises several lookup error types
            if not self._tf_warned:
                self._tf_warned = True
                log.warning("no map->%s TF yet; dropping frames until it appears", frame)
            return None
        tr, ro = t.transform.translation, t.transform.rotation
        return (tr.x, tr.y, tr.z), (ro.x, ro.y, ro.z, ro.w)

    def on_odom(self, msg) -> None:
        p, q = odometry_to_pose(msg)
        if self.last_xy is not None:
            step = math.hypot(p[0] - self.last_xy[0], p[1] - self.last_xy[1])
            if step < 1.0:  # ignore SLAM-correction jumps
                self.distance_m += step
        self.last_xy = (p[0], p[1])
        self.odom_vel = (float(msg.twist.twist.linear.x),
                         float(msg.twist.twist.angular.z))
        self._post(protocol.CH_POSE, protocol.pose_payload(p, q),
                   stamp_to_seconds(msg.header.stamp))

    def on_cmd_vel(self, msg) -> None:
        self.cmd_vel = (float(msg.linear.x), float(msg.angular.z))
        self.cmd_vel_t = time.monotonic()

    def on_mission(self, msg) -> None:
        """slam_bringup's /explore/status: std_msgs/String carrying JSON like
        {"state": "EXPLORING", "frontier_count": 721, ...} -> mission channel."""
        import json
        try:
            data = json.loads(msg.data)
        except (ValueError, TypeError):
            return
        if not isinstance(data, dict):
            return
        state = str(data.pop("state", "?"))
        # flatten one level (home_pose: {x, y} -> home_x / home_y)
        fields: dict = {}
        for k, v in data.items():
            if isinstance(v, dict):
                for k2, v2 in v.items():
                    fields[f"{k}_{k2}"] = v2
            else:
                fields[k] = v
        self._post(protocol.CH_MISSION, protocol.mission_payload(state, fields))

    def on_detections(self, msg) -> None:
        """vision_msgs/Detection3DArray -> persistent object memory.

        Detections in a non-map frame ride TF; same-label hits within
        MERGE_RADIUS update the existing object (count/confidence/last_seen),
        otherwise a new object is created with the latest camera JPEG as its
        thumbnail (Roborock-style object-on-map).
        """
        MERGE_RADIUS = 0.75
        frame = msg.header.frame_id
        tq = None
        if frame and frame != "map":
            tq = self._lookup_map_tf(frame)
            if tq is None:
                return
        changed = False
        now = time.time()
        for det in msg.detections:
            if not det.results:
                continue
            hyp = max(det.results, key=lambda r: r.hypothesis.score)
            label = str(hyp.hypothesis.class_id)
            c = det.bbox.center.position
            p = [c.x, c.y, c.z]
            if tq is not None:
                import numpy as np
                p = transform_xyzi(
                    np.array([[p[0], p[1], p[2], 0]], dtype=np.float32), *tq)[0, :3].tolist()
            for obj in self.objects:
                if obj["label"] == label and \
                        math.hypot(obj["p"][0] - p[0], obj["p"][1] - p[1]) < MERGE_RADIUS:
                    obj["count"] += 1
                    obj["last_seen"] = now
                    obj["confidence"] = max(obj["confidence"], float(hyp.hypothesis.score))
                    changed = True
                    break
            else:
                obj = {"id": f"obj-{len(self.objects) + 1}", "label": label,
                       "confidence": float(hyp.hypothesis.score), "p": p,
                       "count": 1, "last_seen": now}
                if self._latest_jpeg is not None:
                    obj["thumb"] = self._latest_jpeg
                self.objects.append(obj)
                changed = True
                self._post(protocol.CH_STATUS,
                           protocol.status_payload("object_detected", label=label, count=1))
        if changed:
            self._post(protocol.CH_OBJECTS, protocol.objects_payload(self.objects))

    def on_imu(self, msg) -> None:
        """Mid-360 IMU at 200 Hz -> decimate to 10 Hz. Orientation included only
        if the driver fuses one (all-zero quaternion means none)."""
        now = time.monotonic()
        if now - self._last_imu_t < 0.1:
            return
        self._last_imu_t = now
        o = msg.orientation
        orientation = None
        if abs(o.x) + abs(o.y) + abs(o.z) + abs(o.w) > 1e-6:
            orientation = (o.x, o.y, o.z, o.w)
        g, a = msg.angular_velocity, msg.linear_acceleration
        self._post(protocol.CH_IMU, protocol.imu_payload(
            angular_vel=(g.x, g.y, g.z), linear_accel=(a.x, a.y, a.z),
            orientation=orientation), stamp_to_seconds(msg.header.stamp))

    def on_image(self, msg, name: str = "rgb") -> None:
        """Camera Image -> JPEG, decimated to the MJPEG fps (per stream)."""
        now = time.monotonic()
        if now - self._last_jpeg_t.get(name, 0.0) < 1.0 / self.mjpeg.fps:
            return
        self._last_jpeg_t[name] = now
        import io

        import numpy as np
        from PIL import Image as PilImage
        arr = np.frombuffer(bytes(msg.data), dtype=np.uint8)
        arr = arr.reshape(msg.height, msg.step // 3 if msg.encoding in ("rgb8", "bgr8")
                          else msg.width, 3)[:, :msg.width, :]
        if msg.encoding == "bgr8":
            arr = arr[:, :, ::-1]
        elif msg.encoding != "rgb8":
            return  # unsupported encoding — D435 color is rgb8 by default
        buf = io.BytesIO()
        PilImage.fromarray(arr, "RGB").save(buf, format="JPEG", quality=80)
        jpeg = buf.getvalue()
        self.mjpeg.set_frame(jpeg, name)
        if name == "rgb":
            self._latest_jpeg = jpeg  # thumbnail source for new objects

    def on_costmap(self, msg, layer: str) -> None:
        grid = occupancygrid_to_grid(msg)
        frame = msg.header.frame_id
        if frame and frame != "map":
            origin = self._origin_to_map(grid["origin"], frame)
            if origin is None:
                return  # TF not ready yet — skip this update
            grid["origin"] = origin
        self._post(protocol.CH_OCCUPANCY_GRID,
                   protocol.occupancy_grid_payload(layer=layer, **grid),
                   stamp_to_seconds(msg.header.stamp))

    def _origin_to_map(self, origin, frame: str):
        """Re-express a 2D grid origin pose from `frame` into the map frame."""
        tq = self._lookup_map_tf(frame)
        if tq is None:
            return None
        (tx, ty, _), (qx, qy, qz, qw) = tq
        tyaw = math.atan2(2.0 * (qw * qz + qx * qy), 1.0 - 2.0 * (qy * qy + qz * qz))
        ox, oy, otheta = origin
        c, s = math.cos(tyaw), math.sin(tyaw)
        return (tx + c * ox - s * oy, ty + s * ox + c * oy, tyaw + otheta)

    def on_plan(self, msg) -> None:
        import numpy as np
        poses = np.empty((len(msg.poses), 3), dtype=np.float32)
        for i, ps in enumerate(msg.poses):
            o = ps.pose.orientation
            poses[i] = (ps.pose.position.x, ps.pose.position.y,
                        math.atan2(2.0 * (o.w * o.z + o.x * o.y),
                                   1.0 - 2.0 * (o.y * o.y + o.z * o.z)))
        self._post(protocol.CH_NAV_PATH, protocol.nav_path_payload(poses),
                   stamp_to_seconds(msg.header.stamp))

    def on_map(self, msg) -> None:
        grid = occupancygrid_to_grid(msg)
        self.map_updates += 1
        known = int((grid["cells"] != -1).sum())
        self.map_known_m2 = known * grid["resolution"] ** 2
        if self.map_updates == 1 or self.map_updates % 5 == 0:
            self.log_clients("info", f"map update #{self.map_updates}: "
                                     f"{grid['width']}x{grid['height']} cells, "
                                     f"{self.map_known_m2:.1f} m² mapped")
        self._post(protocol.CH_OCCUPANCY_GRID,
                   protocol.occupancy_grid_payload(**grid),
                   stamp_to_seconds(msg.header.stamp))

    # -- nav (jobs run on ROS thread; replies marshalled back to asyncio) ----

    def _reply_threadsafe(self, client: Client, data: dict) -> None:
        if self.loop is not None:
            self.loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(self.server.reply_ack(client, data)))

    def _ros_send_goal(self, cmd_id: int, client: Client,
                       x: float, y: float, theta: float) -> None:
        if self._nav_client is None or self._nav_goal_type is None or self._node is None:
            self._reply_threadsafe(client, protocol.goal_ack_payload(
                cmd_id, "", False, "nav2 action client unavailable"))
            return
        if not self._nav_client.server_is_ready():
            self._reply_threadsafe(client, protocol.goal_ack_payload(
                cmd_id, "", False, "navigate_to_pose action server not ready — is Nav2 up?"))
            return

        self._goal_seq += 1
        goal_id = f"g-{self._goal_seq:03d}"
        goal = self._nav_goal_type.Goal()
        goal.pose.header.frame_id = "map"
        goal.pose.header.stamp = self._node.get_clock().now().to_msg()
        goal.pose.pose.position.x = x
        goal.pose.pose.position.y = y
        goal.pose.pose.orientation.z = math.sin(theta / 2.0)
        goal.pose.pose.orientation.w = math.cos(theta / 2.0)

        future = self._nav_client.send_goal_async(
            goal, feedback_callback=lambda fb: self._on_nav_feedback(goal_id, fb))
        future.add_done_callback(
            lambda f: self._on_goal_response(cmd_id, client, goal_id, f))
        log.info("nav goal %s: (%.2f, %.2f, %.2f rad)", goal_id, x, y, theta)

    def _on_goal_response(self, cmd_id: int, client: Client, goal_id: str, future) -> None:
        handle = future.result()
        if not handle.accepted:
            self._reply_threadsafe(client, protocol.goal_ack_payload(
                cmd_id, goal_id, False, "rejected by planner"))
            self._post(protocol.CH_NAV_STATUS,
                       protocol.nav_status_payload("rejected", goal_id))
            return
        self._goal_handle = handle
        self._active_goal_id = goal_id
        self._reply_threadsafe(client, protocol.goal_ack_payload(cmd_id, goal_id, True))
        self._post(protocol.CH_NAV_STATUS,
                   protocol.nav_status_payload("accepted", goal_id))
        self.log_clients("info", f"nav goal {goal_id} accepted")
        handle.get_result_async().add_done_callback(
            lambda f: self._on_nav_result(goal_id, f))

    def _on_nav_feedback(self, goal_id: str, fb) -> None:
        now = time.monotonic()
        if now - self._last_feedback < NAV_FEEDBACK_MIN_INTERVAL:
            return
        self._last_feedback = now
        feedback = fb.feedback
        eta = feedback.estimated_time_remaining
        self._post(protocol.CH_NAV_STATUS, protocol.nav_status_payload(
            "navigating", goal_id,
            distance_m=round(float(feedback.distance_remaining), 2),
            eta_s=round(eta.sec + eta.nanosec * 1e-9, 1)))

    def _on_nav_result(self, goal_id: str, future) -> None:
        from action_msgs.msg import GoalStatus
        status = future.result().status
        state = {GoalStatus.STATUS_SUCCEEDED: "succeeded",
                 GoalStatus.STATUS_CANCELED: "canceled"}.get(status, "aborted")
        self._post(protocol.CH_NAV_STATUS, protocol.nav_status_payload(state, goal_id))
        self.log_clients("warn" if state == "aborted" else "info",
                         f"nav goal {goal_id} {state}")
        if self._active_goal_id == goal_id:
            self._active_goal_id = None
            self._goal_handle = None

    def _ros_set_param(self, cmd_id: int, client: Client,
                       node_name: str, params: dict) -> None:
        """Forward set_param to a target node's parameter service (ROS thread)."""
        from rcl_interfaces.msg import Parameter, ParameterValue, ParameterType
        from rcl_interfaces.srv import SetParameters

        def to_param(name: str, value) -> Parameter:
            pv = ParameterValue()
            if isinstance(value, bool):
                pv.type, pv.bool_value = ParameterType.PARAMETER_BOOL, value
            elif isinstance(value, int):
                pv.type, pv.integer_value = ParameterType.PARAMETER_INTEGER, value
            elif isinstance(value, float):
                pv.type, pv.double_value = ParameterType.PARAMETER_DOUBLE, value
            else:
                pv.type, pv.string_value = ParameterType.PARAMETER_STRING, str(value)
            return Parameter(name=name, value=pv)

        srv = f"/{node_name.lstrip('/')}/set_parameters"
        cli = self._node.create_client(SetParameters, srv)
        if not cli.wait_for_service(timeout_sec=1.0):
            self._node.destroy_client(cli)
            self._reply_threadsafe(client, protocol.param_ack_payload(
                cmd_id, node_name, {}, params))
            self.log_clients("warn", f"set_param: {srv} not available")
            return
        request = SetParameters.Request(
            parameters=[to_param(k, v) for k, v in params.items()])
        future = cli.call_async(request)

        def done(f):
            accepted, rejected = {}, {}
            try:
                results = f.result().results
                for (name, value), result in zip(params.items(), results):
                    (accepted if result.successful else rejected)[name] = value
                if rejected:
                    self.log_clients("warn", f"set_param {node_name}: rejected {rejected}")
                else:
                    self.log_clients("info", f"set_param {node_name}: {accepted}")
            except Exception as e:  # noqa: BLE001
                rejected = params
                self.log_clients("warn", f"set_param {node_name} failed: {e}")
            self._node.destroy_client(cli)
            self._reply_threadsafe(client, protocol.param_ack_payload(
                cmd_id, node_name, accepted, rejected))

        future.add_done_callback(done)

    def _ros_cancel_goal(self, cmd_id: int, client: Client, goal_id) -> None:
        handle = self._goal_handle
        ok = handle is not None and goal_id in (None, self._active_goal_id)
        if ok:
            handle.cancel_goal_async()  # result callback broadcasts "canceled"
        self._reply_threadsafe(client, protocol.cancel_ack_payload(cmd_id, ok))

    # -- command side (asyncio) ----------------------------------------------

    async def on_command(self, cmd: dict, client: Client) -> None:
        match cmd.get("cmd"):
            case "ping":
                await self.server.reply_ack(
                    client, protocol.pong_payload(cmd.get("id", 0), cmd.get("t", 0.0)))
            case "set_param":
                cmd_id = cmd.get("id", 0)
                node_name = str(cmd.get("node", ""))
                params = dict(cmd.get("params", {}))
                self._ros_jobs.put(
                    lambda: self._ros_set_param(cmd_id, client, node_name, params))
            case "send_goal":
                cmd_id = cmd.get("id", 0)
                x, y = float(cmd.get("x", 0.0)), float(cmd.get("y", 0.0))
                theta = float(cmd.get("theta", 0.0))
                self._ros_jobs.put(
                    lambda: self._ros_send_goal(cmd_id, client, x, y, theta))
            case "cancel_goal":
                cmd_id = cmd.get("id", 0)
                goal_id = cmd.get("goal_id")
                self._ros_jobs.put(
                    lambda: self._ros_cancel_goal(cmd_id, client, goal_id))
            case "map_save":
                try:
                    info = self.mapacc.save_qpc(
                        cmd.get("path") or f"maps/map_{int(time.time())}.qpc")
                    await self.server.reply_ack(client, {
                        "cmd": "map_save_ack", "id": cmd.get("id", 0), "ok": True, **info})
                    self.log_clients("info", f"map saved: {info['path']} "
                                             f"({info['points']:,} pts)")
                except (ValueError, OSError) as e:
                    await self.server.reply_ack(client, {
                        "cmd": "map_save_ack", "id": cmd.get("id", 0), "ok": False,
                        "message": str(e)})
            case other:
                log.info("ignoring unknown command %r", other)

    # -- main ----------------------------------------------------------------

    async def velocity_loop(self) -> None:
        """cmd vs odom velocities at 10 Hz — the smear detector's data feed.
        Commanded velocity decays to 0 when Nav2 stops publishing (>0.5 s)."""
        while True:
            await asyncio.sleep(0.1)
            cmd_vx, cmd_wz = self.cmd_vel
            if time.monotonic() - self.cmd_vel_t > 0.5:
                cmd_vx, cmd_wz = 0.0, 0.0
            odom_vx, odom_wz = self.odom_vel
            self.server.broadcast(protocol.CH_VELOCITY, protocol.velocity_payload(
                cmd_vx=round(cmd_vx, 3), cmd_wz=round(cmd_wz, 3),
                odom_vx=round(odom_vx, 3), odom_wz=round(odom_wz, 3)))

    async def stats_loop(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            scan_hz = float(self.scan_frames - self._scan_frames_last)
            self._scan_frames_last = self.scan_frames
            self.server.broadcast(protocol.CH_STATS, protocol.stats_payload(
                keyframes=self.map_updates,
                total_pts=self.total_pts,
                distance_m=round(self.distance_m, 2),
                duration_s=round(time.time() - self.t0, 1),
                scan_hz=scan_hz,
                health=1.0,
                clients=len(self.server.clients)))

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        threading.Thread(target=self.ros_thread, daemon=True, name="rclpy").start()
        loops = [
            self.server.serve_forever(self.args.host, self.args.port),
            self.stats_loop(),
            self.velocity_loop(),
        ]
        if self.mjpeg is not None:
            loops.append(self.mjpeg.serve_forever(self.args.host, self.args.mjpeg_port))
        await asyncio.gather(*loops)


def main() -> None:
    parser = argparse.ArgumentParser(description="ROS2 -> WebSocket viewer bridge")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--name", default="ros2",
                        help="platform name shown in the viewer header "
                             "(e.g. go2, indoor-rover, r2d2, roboscout)")
    parser.add_argument("--stack", choices=sorted(STACK_PRESETS), default="3d",
                        help="topic preset: 3d (FAST-LIO2/RTABMap) or 2d (slam_toolbox)")
    parser.add_argument("--scan-topic", default=None,
                        help="scan topic ('' disables; default from --stack)")
    parser.add_argument("--scan-msg", choices=["pointcloud2", "laserscan"],
                        default="pointcloud2",
                        help="scan message type (laserscan for RPLidar/Neato)")
    parser.add_argument("--map-voxel", type=float, default=0.10,
                        help="accumulated-map dedup voxel size, meters")
    parser.add_argument("--odom-topic", default=None,
                        help="nav_msgs/Odometry topic (default from --stack)")
    parser.add_argument("--map-topic", default=None,
                        help="nav_msgs/OccupancyGrid topic ('' disables; default from --stack)")
    parser.add_argument("--global-costmap-topic", default="/global_costmap/costmap",
                        help="Nav2 global costmap OccupancyGrid ('' disables)")
    parser.add_argument("--local-costmap-topic", default="/local_costmap/costmap",
                        help="Nav2 local costmap OccupancyGrid ('' disables)")
    parser.add_argument("--plan-topic", default="/plan",
                        help="Nav2 global plan nav_msgs/Path ('' disables)")
    parser.add_argument("--cmd-vel-topic", default="/cmd_vel",
                        help="commanded Twist for the velocity channel ('' disables)")
    parser.add_argument("--mission-topic", default="/explore/status",
                        help="std_msgs/String JSON mission status ('' disables)")
    parser.add_argument("--detections-topic", default="",
                        help="vision_msgs/Detection3DArray for object mapping ('' disables)")
    parser.add_argument("--imu-topic", default="/livox/imu",
                        help="sensor_msgs/Imu topic, decimated to 10 Hz ('' disables)")
    parser.add_argument("--camera-topic", default="/camera/camera/color/image_raw",
                        help="single-camera shorthand: rgb stream Image topic ('' disables)")
    parser.add_argument("--camera", action="append", default=None, metavar="NAME=TOPIC",
                        help="named camera stream (repeatable, up to 4); overrides --camera-topic")
    parser.add_argument("--mjpeg-port", type=int, default=8080,
                        help="MJPEG camera port (0 disables)")
    parser.add_argument("--decimate", type=int, default=1,
                        help="keep every k-th scan point")
    parser.add_argument("--intensity-scale", type=float, default=1.0 / 255.0,
                        help="raw intensity -> 0..1 (default 1/255 for Livox reflectivity)")
    args = parser.parse_args()

    preset = STACK_PRESETS[args.stack]
    if args.scan_topic is None:
        args.scan_topic = preset["scan"]
    if args.odom_topic is None:
        args.odom_topic = preset["odom"]
    if args.map_topic is None:
        args.map_topic = preset["map"]

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    try:
        asyncio.run(Ros2Bridge(args).run())
    except KeyboardInterrupt:
        log.info("bye")


if __name__ == "__main__":
    main()
