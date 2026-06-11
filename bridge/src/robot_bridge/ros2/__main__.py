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
from ..server import BridgeServer, Client
from .converters import (
    occupancygrid_to_grid,
    odometry_to_pose,
    pointcloud2_to_xyzi,
    stamp_to_seconds,
)

log = logging.getLogger("robot_bridge.ros2")

# Topic presets per slam_bringup stack. /cloud_registered is FAST-LIO2's
# WORLD-frame cloud — the wire protocol requires scan points in map frame
# (/cloud_registered_body is body frame: RTABMap's input, not ours). The 2D
# stack has no world-frame cloud, so scan is disabled there.
STACK_PRESETS = {
    "3d": {"scan": "/cloud_registered", "odom": "/Odometry", "map": "/map"},
    "2d": {"scan": "", "odom": "/odom", "map": "/map"},
}

NAV_ACTION = "navigate_to_pose"
NAV_FEEDBACK_MIN_INTERVAL = 0.5  # rate-limit nav_status to 2 Hz


class Ros2Bridge:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        channels = ["pose", "occupancy_grid", "stats", "log", "nav_status"]
        if args.scan_topic:
            channels.append("scan")
        self.server = BridgeServer(
            server_name="ros2", channels=channels, app_version="0.1.0",
            command_handler=self.on_command)
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
            node.create_subscription(PointCloud2, self.args.scan_topic, self.on_scan, 10)
            subscribed.append(self.args.scan_topic)
        if self.args.odom_topic:
            node.create_subscription(Odometry, self.args.odom_topic, self.on_odom, 50)
            subscribed.append(self.args.odom_topic)
        if self.args.map_topic:
            # slam_toolbox publishes /map transient-local; match that QoS
            from rclpy.qos import (
                DurabilityPolicy, QoSProfile, ReliabilityPolicy)
            map_qos = QoSProfile(
                depth=1,
                reliability=ReliabilityPolicy.RELIABLE,
                durability=DurabilityPolicy.TRANSIENT_LOCAL)
            node.create_subscription(OccupancyGrid, self.args.map_topic,
                                     self.on_map, map_qos)
            subscribed.append(self.args.map_topic)

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
        self.scan_frames += 1
        self.total_pts += len(xyzi)
        self._post(protocol.CH_SCAN, protocol.pack_scan(xyzi),
                   stamp_to_seconds(msg.header.stamp))

    def on_odom(self, msg) -> None:
        p, q = odometry_to_pose(msg)
        if self.last_xy is not None:
            step = math.hypot(p[0] - self.last_xy[0], p[1] - self.last_xy[1])
            if step < 1.0:  # ignore SLAM-correction jumps
                self.distance_m += step
        self.last_xy = (p[0], p[1])
        self._post(protocol.CH_POSE, protocol.pose_payload(p, q),
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
                # TODO(jetson): forward to the target node via rclpy parameter client.
                # Until then: log and reject so the UI shows the truth.
                log.info("set_param (not yet forwarded): %s", cmd)
                await self.server.reply_ack(client, protocol.param_ack_payload(
                    cmd.get("id", 0), cmd.get("node", ""), {}, cmd.get("params", {})))
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
            case other:
                log.info("ignoring unknown command %r", other)

    # -- main ----------------------------------------------------------------

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
        await asyncio.gather(
            self.server.serve_forever(self.args.host, self.args.port),
            self.stats_loop(),
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="ROS2 -> WebSocket viewer bridge")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--stack", choices=sorted(STACK_PRESETS), default="3d",
                        help="topic preset: 3d (FAST-LIO2/RTABMap) or 2d (slam_toolbox)")
    parser.add_argument("--scan-topic", default=None,
                        help="world-frame PointCloud2 ('' disables; default from --stack)")
    parser.add_argument("--odom-topic", default=None,
                        help="nav_msgs/Odometry topic (default from --stack)")
    parser.add_argument("--map-topic", default=None,
                        help="nav_msgs/OccupancyGrid topic ('' disables; default from --stack)")
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
