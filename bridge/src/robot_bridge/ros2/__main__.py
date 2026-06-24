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
    pointcloud2_to_xyzrgb,
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
    "3d": {"scan": "/cloud_registered", "odom": "/Odometry", "map": "/map",
           "odom_frame": "camera_init", "scan_low": None},
    "2d": {"scan": "/livox/lidar", "odom": "/odom", "map": "/map",
           "odom_frame": "odom", "scan_low": "/scan_low"},
}

# map->odom jump beyond these = SLAM correction: the accumulated 3D map's baked
# positions are stale relative to the corrected world -> re-bake
CORRECTION_DIST_M = 0.15
CORRECTION_YAW_RAD = 0.10

NAV_ACTION = "navigate_to_pose"
NAV_FEEDBACK_MIN_INTERVAL = 0.5  # rate-limit nav_status to 2 Hz

# /rosout forwarding: the robot's live "thought process". Per-node minimum
# levels (rcl Log levels: 10 debug, 20 info, 30 warn, 40 error, 50 fatal) —
# the mission node's INFO lines are the decisions; nav nodes only matter when
# they complain.
ROSOUT_NODE_LEVELS = {
    "explore_manager": 20,
    "bt_navigator": 30,
    "planner_server": 30,
    "controller_server": 30,
    "behavior_server": 30,
    "velocity_smoother": 30,
    "slam_toolbox": 30,
    "rf2o_laser_odometry": 30,
}
ROSOUT_MAX_HZ = 5.0  # global rate cap so a log storm can't flood the channel

# Odometry between-samples jump beyond this = divergence (rf2o lost track) or a
# SLAM correction — surfaced as the `jump` flag on the odom diag.
ODOM_JUMP_M = 0.5

# Nav2 behavior-tree leaves that mean a recovery is running. A transition INTO
# RUNNING for any of these increments the recovery counter.
RECOVERY_NODES = ("Spin", "BackUp", "Wait", "DriveOnHeading",
                  "ClearEntireCostmap", "ClearCostmapAroundRobot",
                  "ClearCostmap", "RecoveryNode", "RoundRobinRecovery")


def _rtabmap_msgs_available() -> bool:
    """True if rtabmap_msgs is importable (only when RTAB-Map is installed).
    Used to decide whether to advertise rtabmap_diag in the hello channels."""
    import importlib.util
    try:
        return importlib.util.find_spec("rtabmap_msgs") is not None
    except (ImportError, ValueError):
        return False


class Ros2Bridge:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        channels = ["pose", "occupancy_grid", "stats", "log", "nav_status",
                    "nav_path", "velocity", "imu", "mission", "node_params",
                    "nav2_diag"]
        if args.scan_topic:
            channels += ["scan", "map"]
        if args.scan_low_topic:
            channels.append("scan_low")
        if args.teleop and args.teleop_topic:
            channels.append("teleop")  # capability flag: bridge accepts cmd_vel
        if args.depth_topic:
            channels.append("depth")
        if args.detections_topic:
            channels.append("objects")
        # per-component diagnostics — advertised by stack so the viewer can show
        # the other stack's tabs as "inactive — not in this stack" (nav2_diag is
        # advertised always: Nav2 can run under either stack).
        if args.stack == "2d":
            channels += ["rf2o_diag", "slam_toolbox_diag"]
        elif args.stack == "3d":
            channels.append("fastlio_diag")
            if _rtabmap_msgs_available():
                channels.append("rtabmap_diag")
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
            cameras=list(self.cameras) if args.mjpeg_port else [],
            on_connect=self.on_client_connect)
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

        # teleop (manual drive): latest browser command, republished to the robot
        # at a fixed rate by a ROS-thread timer. Written from the asyncio command
        # handler, read by the ROS thread — plain attributes, fine under the GIL.
        self._teleop_pub = None          # rclpy Twist publisher (ROS thread only)
        self._teleop_msg_type = None     # geometry_msgs/Twist (ROS thread only)
        self._teleop_cmd = (0.0, 0.0)    # latest clamped (vx, wz)
        self._teleop_t = 0.0             # monotonic stamp of the latest command
        self._teleop_live = False        # True while a non-expired command stands
        self._tf_buffer = None
        self._tf_warned = False
        self._bench_mode = False  # true while scans render untransformed (no TF)
        self._rosout_last = 0.0
        self._rosout_dropped = 0
        self._ext_nav_state: str | None = None
        self.scan2d_count = 0
        self._scan2d_last = 0
        self._last_map_odom: tuple[float, float, float] | None = None
        self._map_correction: dict | None = None  # latest map->odom delta

        # -- per-component diagnostics state (written by ROS thread) ----------
        # odom (rf2o 2d / fastlio 3d): rate from a frame counter, latest pose/vel
        self.odom_frames = 0
        self._odom_frames_last = 0
        self.odom_pose = (0.0, 0.0, 0.0)   # x, y, yaw
        self.odom_cov_trace: float | None = None
        self._last_odom_t = 0.0            # monotonic; 0 = none yet
        self.odom_jump = False
        # slam_toolbox: last map dims + pose-graph counts
        self.map_dims: tuple[int, int, float] | None = None  # (w, h, res)
        self._map_updates_last = 0
        self._graph_nodes: int | None = None
        self._graph_edges: int | None = None
        # nav2: BT leaf + recovery counter + plan length
        self._bt_node: str | None = None
        self._nav2_recoveries = 0
        self._nav2_last_recovery: str | None = None
        self._plan_poses = 0
        # rtabmap: from /rtabmap/info, event-driven (rate-limited)
        self._rtab_loop_total = 0
        self._rtab_loop_last: int | None = None
        self._rtab_proximity = 0
        self._rtab_ref_id = 0
        self._rtab_proc_ms: float | None = None
        self._rtab_wm: int | None = None
        self._rtab_words: int | None = None
        self._rtab_loc_t = 0.0
        self._rtab_last_emit = 0.0

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
        # watch the 2D /scan that rf2o consumes — distinct from the 3D cloud;
        # it's the input whose silent death corrupts maps (rate goes into stats)
        if self.args.scan2d_topic and self.args.scan_msg != "laserscan":
            from sensor_msgs.msg import LaserScan
            from rclpy.qos import qos_profile_sensor_data
            node.create_subscription(LaserScan, self.args.scan2d_topic,
                                     lambda _msg: self._count_scan2d(),
                                     qos_profile_sensor_data)
            subscribed.append(f"{self.args.scan2d_topic} (watch)")
        # Low obstacle band (slam_bringup /scan_low, 0.05-0.15 m): the
        # ankle-height clutter the costmap dodges (dog bowls, shoes).
        # Rendered as its own GUI layer so "why did it swerve" is visible.
        if self.args.scan_low_topic:
            from sensor_msgs.msg import LaserScan as LaserScanLow
            from rclpy.qos import qos_profile_sensor_data as _qos_low
            node.create_subscription(LaserScanLow, self.args.scan_low_topic,
                                     self.on_scan_low, _qos_low)
            subscribed.append(self.args.scan_low_topic)
        if self.args.depth_topic:
            from rclpy.qos import qos_profile_sensor_data
            node.create_subscription(PointCloud2, self.args.depth_topic,
                                     self.on_depth, qos_profile_sensor_data)
            subscribed.append(self.args.depth_topic)
        if self.args.rosout:
            from rcl_interfaces.msg import Log as RclLog
            node.create_subscription(RclLog, "/rosout", self.on_rosout, 50)
            subscribed.append("/rosout")
        # -- per-component diagnostics subscriptions -------------------------
        # slam_toolbox pose-graph (2d): node/edge counts from the marker array
        if self.args.stack == "2d" and self.args.slam_graph_topic:
            from visualization_msgs.msg import MarkerArray
            node.create_subscription(MarkerArray, self.args.slam_graph_topic,
                                     self.on_slam_graph, 1)
            subscribed.append(self.args.slam_graph_topic)
        # Nav2 behavior-tree log: active leaf + recovery detection (optional msg)
        if self.args.bt_log_topic:
            try:
                from nav2_msgs.msg import BehaviorTreeLog
                node.create_subscription(BehaviorTreeLog, self.args.bt_log_topic,
                                         self.on_bt_log, 10)
                subscribed.append(self.args.bt_log_topic)
            except ImportError:
                log.warning("nav2_msgs not available — BT-log diagnostics off")
        # RTAB-Map /rtabmap/info (3d): loop closures, timing, memory (optional msg)
        if self.args.stack == "3d" and self.args.rtabmap_info_topic:
            try:
                from rtabmap_msgs.msg import Info as RtabInfo
                node.create_subscription(RtabInfo, self.args.rtabmap_info_topic,
                                         self.on_rtabmap_info, 10)
                subscribed.append(self.args.rtabmap_info_topic)
                if self.args.rtabmap_loc_topic:
                    from geometry_msgs.msg import PoseWithCovarianceStamped
                    node.create_subscription(
                        PoseWithCovarianceStamped, self.args.rtabmap_loc_topic,
                        self.on_rtabmap_loc, 10)
            except ImportError:
                log.warning("rtabmap_msgs not available — rtabmap diagnostics off")
        # status of goals sent by OTHER nodes (explore) to Nav2 — the GUI's own
        # goals already report via the action client; this covers the rest
        from action_msgs.msg import GoalStatusArray
        node.create_subscription(GoalStatusArray,
                                 f"/{NAV_ACTION}/_action/status",
                                 self.on_external_nav_status, 10)
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

        # teleop: publish manual-drive Twist commands from the viewer's joystick.
        # A timer republishes the latest command at a fixed rate and enforces the
        # deadman (zero on staleness) so a dropped client always stops the robot.
        if self.args.teleop and self.args.teleop_topic:
            from geometry_msgs.msg import Twist as TwistPub
            self._teleop_msg_type = TwistPub
            self._teleop_pub = node.create_publisher(
                TwistPub, self.args.teleop_topic, 10)
            node.create_timer(1.0 / self.args.teleop_rate, self._publish_teleop)
            subscribed.append(f"teleop->{self.args.teleop_topic} "
                              f"(≤{self.args.teleop_max_vx} m/s, "
                              f"≤{self.args.teleop_max_wz} rad/s)")

        # drain asyncio -> ROS jobs (nav goal send/cancel) at 20 Hz
        node.create_timer(0.05, self._drain_jobs)
        # watch map->odom for SLAM correction jumps (re-bake the 3D map)
        node.create_timer(1.0, self._check_map_correction)

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

    def on_depth(self, msg) -> None:
        """RealSense depth/color cloud -> depth channel (rate-limited,
        decimated, TF'd to map like scans; raw sensor frame in bench mode)."""
        now = time.monotonic()
        if now - getattr(self, "_last_depth_t", 0.0) < 1.0 / self.args.depth_hz:
            return
        self._last_depth_t = now
        try:
            pts = pointcloud2_to_xyzrgb(msg, decimate=self.args.depth_decimate)
        except ValueError as e:
            if not getattr(self, "_depth_warned", False):
                self._depth_warned = True
                log.warning("depth cloud unusable: %s", e)
            return
        frame = msg.header.frame_id
        if frame and frame != "map":
            tq = self._lookup_map_tf(frame, msg.header.stamp)
            if tq is not None:
                pts = transform_xyzi(pts, *tq)  # transforms cols 0-2, rest pass through
        self._post(protocol.CH_DEPTH, protocol.pack_xyzrgb(pts),
                   stamp_to_seconds(msg.header.stamp))

    def on_laserscan(self, msg) -> None:
        self._publish_scan(laserscan_to_xyzi(msg), msg.header)

    def on_scan_low(self, msg) -> None:
        """Low obstacle band — same xyzi packing as scan, but never fed to
        map accumulation and silently dropped without TF (no bench mode:
        a low band in the raw sensor frame would just be confusing)."""
        xyzi = laserscan_to_xyzi(msg)
        if len(xyzi) == 0:
            return
        frame = msg.header.frame_id
        if frame and frame != "map":
            tq = self._lookup_map_tf(frame, msg.header.stamp)
            if tq is None:
                return
            xyzi = transform_xyzi(xyzi, *tq)
        self._post(protocol.CH_SCAN_LOW, protocol.pack_scan(xyzi),
                   stamp_to_seconds(msg.header.stamp))

    def _publish_scan(self, xyzi, header) -> None:
        frame = header.frame_id
        transformed = True
        if frame and frame != "map":
            tq = self._lookup_map_tf(frame, header.stamp)
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

    def _lookup_map_tf(self, frame: str, stamp=None):
        """map<-frame transform as ((x,y,z), (qx,qy,qz,qw)), or None.

        With `stamp`, looks up the transform at that time (so a rotating scan
        is placed where the robot WAS, not where it is now) and falls back to
        latest if that instant isn't in the TF buffer yet."""
        import rclpy.time
        try:
            when = rclpy.time.Time.from_msg(stamp) if stamp is not None \
                else rclpy.time.Time()
            t = self._tf_buffer.lookup_transform("map", frame, when)
        except Exception:  # noqa: BLE001 — tf2 raises several lookup error types
            if stamp is not None:
                return self._lookup_map_tf(frame)  # fall back to latest
            if not self._tf_warned:
                self._tf_warned = True
                log.warning("no map->%s TF yet; dropping frames until it appears", frame)
            return None
        tr, ro = t.transform.translation, t.transform.rotation
        return (tr.x, tr.y, tr.z), (ro.x, ro.y, ro.z, ro.w)

    def _check_map_correction(self) -> None:
        """SLAM corrections move the map frame under the baked 3D points.
        On a significant map->odom jump: reset the accumulator and tell the
        viewer to clear, so the map re-bakes against the corrected world."""
        tq = self._lookup_map_tf(self.args.odom_frame)
        if tq is None:
            return
        (x, y, _), (qx, qy, qz, qw) = tq
        yaw = math.atan2(2.0 * (qw * qz + qx * qy), 1.0 - 2.0 * (qy * qy + qz * qz))
        prev = self._last_map_odom
        self._last_map_odom = (x, y, yaw)
        if prev is None:
            return
        d = math.hypot(x - prev[0], y - prev[1])
        dyaw = abs(math.atan2(math.sin(yaw - prev[2]), math.cos(yaw - prev[2])))
        # record the per-tick map->odom shift for the slam_toolbox diag (how
        # much SLAM is correcting odometry drift right now)
        self._map_correction = {"dist_m": round(d, 3),
                                "yaw_deg": round(math.degrees(dyaw), 2)}
        if d > CORRECTION_DIST_M or dyaw > CORRECTION_YAW_RAD:
            self.mapacc.reset()
            # status channel is reliable/ordered — a droppable clear marker
            # could be evicted by the next map delta
            self._post(protocol.CH_STATUS, protocol.status_payload("map_reset"))
            self.log_clients("info",
                             f"SLAM correction (Δ{d:.2f} m, {math.degrees(dyaw):.1f}°) — "
                             f"3D map re-baking against corrected frame")

    def on_odom(self, msg) -> None:
        p, q = odometry_to_pose(msg)
        if self.last_xy is not None:
            step = math.hypot(p[0] - self.last_xy[0], p[1] - self.last_xy[1])
            if step < 1.0:  # ignore SLAM-correction jumps
                self.distance_m += step
            self.odom_jump = step > ODOM_JUMP_M  # divergence / correction
        self.last_xy = (p[0], p[1])
        self.odom_vel = (float(msg.twist.twist.linear.x),
                         float(msg.twist.twist.angular.z))
        # odom diagnostics: yaw, covariance trace, rate (frame counter), age
        yaw = math.atan2(2.0 * (q[3] * q[2] + q[0] * q[1]),
                         1.0 - 2.0 * (q[1] * q[1] + q[2] * q[2]))
        self.odom_pose = (p[0], p[1], yaw)
        cov = msg.pose.covariance
        tr = float(cov[0] + cov[7] + cov[35])  # xx + yy + yaw-yaw
        self.odom_cov_trace = round(tr, 4) if abs(tr) > 1e-9 else None
        self.odom_frames += 1
        self._last_odom_t = time.monotonic()
        self._post(protocol.CH_POSE, protocol.pose_payload(p, q),
                   stamp_to_seconds(msg.header.stamp))

    def on_cmd_vel(self, msg) -> None:
        self.cmd_vel = (float(msg.linear.x), float(msg.angular.z))
        self.cmd_vel_t = time.monotonic()

    def _publish_teleop(self) -> None:
        """Republish the latest teleop command at a fixed rate (ROS thread).

        Holding the command steady between browser packets gives the robot a
        smooth stream despite WiFi jitter. The deadman: once the command is
        older than --teleop-timeout, publish ONE zero Twist and go quiet — so a
        released joystick, a closed tab, or a dropped link all stop the robot.
        """
        if self._teleop_pub is None:
            return
        fresh = (time.monotonic() - self._teleop_t) <= self.args.teleop_timeout
        if fresh:
            vx, wz = self._teleop_cmd
        elif self._teleop_live:
            vx, wz = 0.0, 0.0          # deadman fired — one zero, then silence
            self._teleop_live = False
        else:
            return                     # idle: don't spam the robot with zeros
        msg = self._teleop_msg_type()
        msg.linear.x = float(vx)
        msg.angular.z = float(wz)
        self._teleop_pub.publish(msg)

    def _count_scan2d(self) -> None:
        self.scan2d_count += 1

    def on_rosout(self, msg) -> None:
        """Forward relevant /rosout lines to the log channel — frontier picks,
        planner failures, recoveries: the robot's reasoning, live in the UI."""
        node_name = msg.name.split(".")[0]
        min_level = ROSOUT_NODE_LEVELS.get(node_name)
        if min_level is None or msg.level < min_level:
            return
        now = time.monotonic()
        if now - self._rosout_last < 1.0 / ROSOUT_MAX_HZ:
            self._rosout_dropped += 1
            return
        self._rosout_last = now
        level = "error" if msg.level >= 40 else "warn" if msg.level >= 30 else "info"
        suffix = f" (+{self._rosout_dropped} suppressed)" if self._rosout_dropped else ""
        self._rosout_dropped = 0
        self._post(protocol.CH_LOG, protocol.log_payload(
            level, f"[{node_name}] {msg.msg}{suffix}"),
            stamp_to_seconds(msg.stamp))

    def on_external_nav_status(self, msg) -> None:
        """GoalStatusArray for navigate_to_pose — surfaces what the EXPLORE
        node's goals are doing (the GUI never sent them)."""
        if not msg.status_list:
            return
        from action_msgs.msg import GoalStatus
        latest = msg.status_list[-1]
        state = {
            GoalStatus.STATUS_ACCEPTED: "accepted",
            GoalStatus.STATUS_EXECUTING: "navigating",
            GoalStatus.STATUS_SUCCEEDED: "succeeded",
            GoalStatus.STATUS_CANCELED: "canceled",
            GoalStatus.STATUS_ABORTED: "aborted",
        }.get(latest.status)
        if state is None or state == self._ext_nav_state:
            return
        self._ext_nav_state = state
        self._post(protocol.CH_NAV_STATUS,
                   protocol.nav_status_payload(state, "explore"))
        if state == "aborted":
            self.log_clients("warn", "nav goal aborted — likely no valid path "
                                     "(check costmap layers for sealed passages)")

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
        self._plan_poses = len(msg.poses)
        self._post(protocol.CH_NAV_PATH, protocol.nav_path_payload(poses),
                   stamp_to_seconds(msg.header.stamp))

    def on_map(self, msg) -> None:
        grid = occupancygrid_to_grid(msg)
        self.map_updates += 1
        self.map_dims = (grid["width"], grid["height"], grid["resolution"])
        known = int((grid["cells"] != -1).sum())
        self.map_known_m2 = known * grid["resolution"] ** 2
        if self.map_updates == 1 or self.map_updates % 5 == 0:
            self.log_clients("info", f"map update #{self.map_updates}: "
                                     f"{grid['width']}x{grid['height']} cells, "
                                     f"{self.map_known_m2:.1f} m² mapped")
        self._post(protocol.CH_OCCUPANCY_GRID,
                   protocol.occupancy_grid_payload(**grid),
                   stamp_to_seconds(msg.header.stamp))

    # -- per-component diagnostics callbacks (ROS thread) --------------------

    def on_slam_graph(self, msg) -> None:
        """slam_toolbox /graph_visualization MarkerArray -> node/edge counts.

        Heuristic (the marker layout varies by version): SPHERE_LIST/POINTS
        markers carry pose-graph vertices as points; LINE_LIST/LINE_STRIP carry
        the constraint edges. Falls back to counting non-text markers. The trend
        (is the graph growing?) matters more than an exact count.
        """
        nodes = 0
        edge_pts = 0
        for m in msg.markers:
            if m.type in (7, 8):        # SPHERE_LIST, POINTS
                nodes += len(m.points)
            elif m.type in (4, 5):      # LINE_STRIP, LINE_LIST
                edge_pts += len(m.points)
            elif m.type == 2:           # one SPHERE marker per node
                nodes += 1
        if nodes == 0:
            nodes = sum(1 for m in msg.markers if m.type != 9)  # exclude TEXT
        self._graph_nodes = nodes
        self._graph_edges = edge_pts // 2 if edge_pts else None

    def on_bt_log(self, msg) -> None:
        """Nav2 nav2_msgs/BehaviorTreeLog -> active leaf + recovery counter.

        A node transitioning INTO RUNNING (previous != RUNNING) is the active
        leaf; if it's a recovery node, bump the recovery counter once per entry.
        """
        for ev in msg.event_log:
            cur = getattr(ev, "current_status", "")
            if cur != "RUNNING":
                continue
            name = getattr(ev, "node_name", "")
            self._bt_node = name
            if getattr(ev, "previous_status", "") != "RUNNING" and \
                    any(r in name for r in RECOVERY_NODES):
                self._nav2_recoveries += 1
                self._nav2_last_recovery = name

    @staticmethod
    def _stat(stats: dict, keys, *, as_int: bool = False):
        """First present key from `keys` in the rtabmap stats dict, or None."""
        for k in keys:
            if k in stats:
                try:
                    return int(float(stats[k])) if as_int else round(float(stats[k]), 1)
                except (TypeError, ValueError):
                    return None
        return None

    def on_rtabmap_info(self, msg) -> None:
        """rtabmap_msgs/Info -> loop closures, processing time, memory.

        Field names differ across rtabmap versions/distros (refId vs ref_id),
        so read them defensively; the stats dict keys vary too — best-effort.
        Emission is rate-limited to 2 Hz.
        """
        self._rtab_ref_id = int(getattr(msg, "ref_id", getattr(msg, "refId", 0)) or 0)
        loop_id = int(getattr(msg, "loop_closure_id",
                              getattr(msg, "loopClosureId", 0)) or 0)
        if loop_id > 0:
            self._rtab_loop_total += 1
            self._rtab_loop_last = loop_id
        prox = int(getattr(msg, "proximity_detection_id",
                           getattr(msg, "proximityDetectionId", 0)) or 0)
        if prox > 0:
            self._rtab_proximity += 1
        try:
            keys = list(getattr(msg, "stats_keys", []) or [])
            vals = list(getattr(msg, "stats_values", []) or [])
            stats = dict(zip(keys, vals))
            self._rtab_proc_ms = self._stat(stats, ("Timing/Total/ms", "Timing/total/ms"))
            self._rtab_wm = self._stat(stats, ("Memory/Working_memory_size/",
                                               "Memory/Working_memory_size"), as_int=True)
            self._rtab_words = self._stat(stats, ("Keypoint/Current_frame/words",
                                                  "Keypoint/Indexed_words/"), as_int=True)
        except Exception:  # noqa: BLE001 — stats are best-effort, never fatal
            pass
        now = time.monotonic()
        if now - self._rtab_last_emit >= 0.5:
            self._rtab_last_emit = now
            loc = None
            if self._rtab_loc_t:
                loc = (now - self._rtab_loc_t) < 3.0
            self._post(protocol.CH_RTABMAP_DIAG, protocol.rtabmap_diag_payload(
                loop_total=self._rtab_loop_total, loop_last_id=self._rtab_loop_last,
                proximity=self._rtab_proximity, ref_id=self._rtab_ref_id,
                proc_ms=self._rtab_proc_ms, wm_size=self._rtab_wm,
                words=self._rtab_words, localized=loc))

    def on_rtabmap_loc(self, msg) -> None:
        """A localization pose means rtabmap is localized (not just mapping)."""
        self._rtab_loc_t = time.monotonic()

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
                cmd_id, node_name, {}, params,
                {k: f"{srv} not available — is the node running / name right?"
                 for k in params}))
            self.log_clients("warn", f"set_param: {srv} not available")
            return
        request = SetParameters.Request(
            parameters=[to_param(k, v) for k, v in params.items()])
        future = cli.call_async(request)

        def done(f):
            accepted, rejected, reasons = {}, {}, {}
            try:
                results = f.result().results
                for (name, value), result in zip(params.items(), results):
                    if result.successful:
                        accepted[name] = value
                    else:
                        rejected[name] = value
                        if result.reason:
                            reasons[name] = result.reason
                if rejected:
                    detail = "; ".join(f"{k}: {v}" for k, v in reasons.items()) or "no reason given"
                    self.log_clients("warn", f"set_param {node_name} rejected — {detail}")
                else:
                    self.log_clients("info", f"set_param {node_name}: {accepted}")
            except Exception as e:  # noqa: BLE001
                rejected = params
                reasons = {k: str(e) for k in params}
                self.log_clients("warn", f"set_param {node_name} failed: {e}")
            self._node.destroy_client(cli)
            self._reply_threadsafe(client, protocol.param_ack_payload(
                cmd_id, node_name, accepted, rejected, reasons))

        future.add_done_callback(done)

    def _ros_cancel_goal(self, cmd_id: int, client: Client, goal_id) -> None:
        handle = self._goal_handle
        ok = handle is not None and goal_id in (None, self._active_goal_id)
        if ok:
            handle.cancel_goal_async()  # result callback broadcasts "canceled"
        self._reply_threadsafe(client, protocol.cancel_ack_payload(cmd_id, ok))

    # -- deployed-config audit (docs/diagnostics.md §1) -----------------------

    async def on_client_connect(self, client: Client) -> None:
        self._ros_jobs.put(self._ros_get_params)

    def _ros_get_params(self) -> None:
        """Read the audited params from each node's get_parameters service.

        Non-blocking: nodes whose service isn't ready right now report None
        (UNKNOWN in the UI — a down node is itself a finding). A 2 s deadline
        timer emits whatever has arrived.
        """
        from rcl_interfaces.srv import GetParameters
        from .audit_params import AUDITED_PARAMS

        results: dict = {name: None for name in AUDITED_PARAMS}
        state = {"pending": 0, "done": False}

        def pv_to_py(pv):
            t = pv.type
            return [None, pv.bool_value, pv.integer_value, pv.double_value,
                    pv.string_value, list(pv.byte_array_value),
                    list(pv.bool_array_value), list(pv.integer_array_value),
                    list(pv.double_array_value), list(pv.string_array_value)][t] \
                if 0 <= t <= 9 else None

        def emit():
            if state["done"]:
                return
            state["done"] = True
            complete = all(v is not None for v in results.values())
            self._post(protocol.CH_NODE_PARAMS,
                       protocol.node_params_payload(results, complete))

        for node_name, names in AUDITED_PARAMS.items():
            cli = self._node.create_client(GetParameters,
                                           f"/{node_name}/get_parameters")
            if not cli.service_is_ready():
                self._node.destroy_client(cli)
                continue
            state["pending"] += 1

            def done(future, node_name=node_name, names=names, cli=cli):
                try:
                    values = future.result().values
                    results[node_name] = {n: pv_to_py(v) for n, v in zip(names, values)}
                except Exception:  # noqa: BLE001
                    pass
                self._node.destroy_client(cli)
                state["pending"] -= 1
                if state["pending"] == 0:
                    emit()

            cli.call_async(GetParameters.Request(names=names)).add_done_callback(done)

        if state["pending"] == 0:
            emit()  # nothing reachable — all-unknown frame, still informative
        else:
            timer_holder = {}

            def deadline():
                timer_holder["t"].cancel()
                emit()

            timer_holder["t"] = self._node.create_timer(2.0, deadline)

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
            case "cmd_vel":
                # high-rate, fire-and-forget (no ack). Clamp here; the ROS-thread
                # timer publishes. Just set plain attributes (GIL-safe) — the
                # job queue would add needless latency to a 20 Hz stream.
                if self.args.teleop and self._teleop_pub is not None:
                    self._teleop_cmd = protocol.clamp_twist(
                        float(cmd.get("vx", 0.0)), float(cmd.get("wz", 0.0)),
                        self.args.teleop_max_vx, self.args.teleop_max_wz)
                    self._teleop_t = time.monotonic()
                    self._teleop_live = True
            case "get_params":
                await self.server.reply_ack(client, {
                    "cmd": "params_ack", "id": cmd.get("id", 0), "ok": True})
                self._ros_jobs.put(self._ros_get_params)
            case "map_save":
                try:
                    # compression can take seconds on a big map — keep the
                    # event loop (and all streaming) alive while it runs
                    info = await asyncio.to_thread(
                        self.mapacc.save_qpc,
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

    async def diag_loop(self) -> None:
        """Per-component diagnostics at 1 Hz (rtabmap emits event-driven from
        its own Info callback). Computes odom rate from a frame counter and
        routes it to rf2o (2d) or fastlio (3d); assembles slam_toolbox + nav2."""
        while True:
            await asyncio.sleep(1.0)
            hz = float(self.odom_frames - self._odom_frames_last)
            self._odom_frames_last = self.odom_frames
            age = round(time.monotonic() - self._last_odom_t, 2) \
                if self._last_odom_t else 999.0
            odom = protocol.odom_diag_payload(
                source="rf2o" if self.args.stack == "2d" else "fastlio",
                hz=hz, pose=self.odom_pose, vel=self.odom_vel,
                cov_trace=self.odom_cov_trace, jump=self.odom_jump, age_s=age)
            if self.args.stack == "2d":
                self.server.broadcast(protocol.CH_RF2O_DIAG, odom)
                self._broadcast_slam_toolbox_diag()
            elif self.args.stack == "3d":
                self.server.broadcast(protocol.CH_FASTLIO_DIAG, odom)
            self._broadcast_nav2_diag()

    def _broadcast_slam_toolbox_diag(self) -> None:
        map_info = None
        if self.map_dims is not None:
            w, h, res = self.map_dims
            map_hz = float(self.map_updates - self._map_updates_last)
            self._map_updates_last = self.map_updates
            map_info = {"w": w, "h": h, "res": round(res, 3),
                        "known_m2": round(self.map_known_m2, 1),
                        "updates": self.map_updates, "update_hz": map_hz}
        graph = None
        if self._graph_nodes is not None:
            graph = {"nodes": self._graph_nodes, "edges": self._graph_edges}
        self.server.broadcast(
            protocol.CH_SLAM_TOOLBOX_DIAG, protocol.slam_toolbox_diag_payload(
                map_info=map_info, graph=graph,
                correction=self._map_correction, mode=None))

    def _broadcast_nav2_diag(self) -> None:
        cvx, cwz = self.cmd_vel
        if time.monotonic() - self.cmd_vel_t > 0.5:
            cvx, cwz = 0.0, 0.0
        state = self._ext_nav_state or \
            ("navigating" if self._active_goal_id else "idle")
        self.server.broadcast(protocol.CH_NAV2_DIAG, protocol.nav2_diag_payload(
            state=state, bt_node=self._bt_node,
            recoveries={"total": self._nav2_recoveries,
                        "last": self._nav2_last_recovery},
            plan_poses=self._plan_poses,
            cmd={"vx": round(cvx, 3), "wz": round(cwz, 3)}, servers=None))

    async def stats_loop(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            scan_hz = float(self.scan_frames - self._scan_frames_last)
            self._scan_frames_last = self.scan_frames
            payload = protocol.stats_payload(
                keyframes=self.map_updates,
                total_pts=self.total_pts,
                distance_m=round(self.distance_m, 2),
                duration_s=round(time.time() - self.t0, 1),
                scan_hz=scan_hz,
                health=1.0,
                clients=len(self.server.clients))
            if self.args.scan2d_topic:
                payload["scan2d_hz"] = float(self.scan2d_count - self._scan2d_last)
                self._scan2d_last = self.scan2d_count
            self.server.broadcast(protocol.CH_STATS, payload)

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        threading.Thread(target=self.ros_thread, daemon=True, name="rclpy").start()
        loops = [
            self.server.serve_forever(self.args.host, self.args.port),
            self.stats_loop(),
            self.velocity_loop(),
            self.diag_loop(),
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
    # teleop (manual drive from the viewer's joystick) -> geometry_msgs/Twist
    parser.add_argument("--teleop", action="store_true", default=True,
                        help="accept cmd_vel teleop from the viewer (default on)")
    parser.add_argument("--no-teleop", dest="teleop", action="store_false",
                        help="disable manual drive (read-only viewer)")
    parser.add_argument("--teleop-topic", default="/cmd_vel",
                        help="Twist topic the joystick drives ('' disables). With "
                             "Nav2 running, point this at a twist_mux input "
                             "(e.g. /cmd_vel_teleop) so manual and autonomous "
                             "commands don't fight")
    parser.add_argument("--teleop-max-vx", type=float, default=0.5,
                        help="max teleop linear speed, m/s (commands are clamped)")
    parser.add_argument("--teleop-max-wz", type=float, default=0.6,
                        help="max teleop angular speed, rad/s (clamped; matches the "
                             "0.6 deployed max_vel_theta)")
    parser.add_argument("--teleop-timeout", type=float, default=0.4,
                        help="deadman: stop the robot if no cmd_vel arrives within "
                             "this many seconds")
    parser.add_argument("--teleop-rate", type=float, default=20.0,
                        help="rate (Hz) the latest teleop command is republished")
    parser.add_argument("--mission-topic", default="/explore/status",
                        help="std_msgs/String JSON mission status ('' disables)")
    parser.add_argument("--scan-low-topic", default=None,
                        help="sensor_msgs/LaserScan low obstacle band "
                             "(preset 2d: /scan_low; '' disables)")
    parser.add_argument("--depth-topic",
                        default="/d435_front/camera/depth/color/points",
                        help="RealSense xyzrgb PointCloud2 ('' disables; needs "
                             "pointcloud.enable=true on the camera node)")
    parser.add_argument("--depth-hz", type=float, default=5.0,
                        help="depth cloud forward rate")
    parser.add_argument("--depth-decimate", type=int, default=8,
                        help="keep every k-th depth point (organized 848x480 is huge)")
    parser.add_argument("--scan2d-topic", default="/scan",
                        help="2D LaserScan to watch (rf2o's input; '' disables)")
    # per-component diagnostics inputs (see DiagnosticsCard in the viewer)
    parser.add_argument("--slam-graph-topic",
                        default="/slam_toolbox/graph_visualization",
                        help="slam_toolbox pose-graph MarkerArray ('' disables)")
    parser.add_argument("--bt-log-topic", default="/behavior_tree_log",
                        help="Nav2 nav2_msgs/BehaviorTreeLog ('' disables)")
    parser.add_argument("--rtabmap-info-topic", default="/rtabmap/info",
                        help="rtabmap_msgs/Info diagnostics ('' disables)")
    parser.add_argument("--rtabmap-loc-topic", default="/rtabmap/localization_pose",
                        help="RTAB-Map localization pose ('' disables)")
    parser.add_argument("--rosout", action="store_true", default=True,
                        help="forward filtered /rosout to the log channel")
    parser.add_argument("--no-rosout", dest="rosout", action="store_false")
    parser.add_argument("--detections-topic", default="",
                        help="vision_msgs/Detection3DArray for object mapping ('' disables)")
    parser.add_argument("--imu-topic", default="/livox/imu",
                        help="sensor_msgs/Imu topic, decimated to 10 Hz ('' disables)")
    # slam_bringup's d435.launch.py: namespace d435_front, node keeps "camera"
    # as its internal name -> /d435_front/camera/... (confirmed via Foxglove)
    parser.add_argument("--camera-topic",
                        default="/d435_front/camera/color/image_raw",
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
    args.odom_frame = preset["odom_frame"]
    if args.scan_topic is None:
        args.scan_topic = preset["scan"]
    if args.odom_topic is None:
        args.odom_topic = preset["odom"]
    if args.map_topic is None:
        args.map_topic = preset["map"]
    if args.scan_low_topic is None:
        args.scan_low_topic = preset.get("scan_low")

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    try:
        asyncio.run(Ros2Bridge(args).run())
    except KeyboardInterrupt:
        log.info("bye")


if __name__ == "__main__":
    main()
