"""rclpy bridge entrypoint — STATUS: compiles, not yet run on hardware.

Run on the Jetson with the ROS2 Humble environment sourced:

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
loop.call_soon_threadsafe.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import threading

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


class Ros2Bridge:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        channels = ["pose", "occupancy_grid"] + (["scan"] if args.scan_topic else [])
        self.server = BridgeServer(
            server_name="ros2", channels=channels, app_version="0.1.0",
            command_handler=self.on_command)
        self.loop: asyncio.AbstractEventLoop | None = None

    # -- ROS side (background thread) ---------------------------------------

    def ros_thread(self) -> None:
        import rclpy  # lazy: only the Jetson has this
        from nav_msgs.msg import OccupancyGrid, Odometry
        from sensor_msgs.msg import PointCloud2

        rclpy.init()
        node = rclpy.create_node("viewer_bridge")
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
        log.info("rclpy spinning: %s", ", ".join(subscribed))
        rclpy.spin(node)

    def _post(self, topic: str, data, ts: float) -> None:
        """Hand a frame from the ROS thread to the asyncio loop."""
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self.server.broadcast, topic, data, ts)

    def on_scan(self, msg) -> None:
        xyzi = pointcloud2_to_xyzi(msg, decimate=self.args.decimate,
                                   intensity_scale=self.args.intensity_scale)
        self._post(protocol.CH_SCAN, protocol.pack_scan(xyzi),
                   stamp_to_seconds(msg.header.stamp))

    def on_odom(self, msg) -> None:
        p, q = odometry_to_pose(msg)
        self._post(protocol.CH_POSE, protocol.pose_payload(p, q),
                   stamp_to_seconds(msg.header.stamp))

    def on_map(self, msg) -> None:
        grid = occupancygrid_to_grid(msg)
        self._post(protocol.CH_OCCUPANCY_GRID,
                   protocol.occupancy_grid_payload(**grid),
                   stamp_to_seconds(msg.header.stamp))

    # -- command side --------------------------------------------------------

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
            case other:
                log.info("ignoring unknown command %r", other)

    # -- main ----------------------------------------------------------------

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        threading.Thread(target=self.ros_thread, daemon=True, name="rclpy").start()
        await self.server.serve_forever(self.args.host, self.args.port)


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
