"""rclpy bridge entrypoint — STATUS: compiles, not yet run on hardware.

Run on the Jetson with the ROS2 Humble environment sourced:

    source /opt/ros/humble/setup.bash
    python -m robot_bridge.ros2 [--host 0.0.0.0] [--port 9090] [--decimate 1]

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
from .converters import odometry_to_pose, pointcloud2_to_xyzi, stamp_to_seconds

log = logging.getLogger("robot_bridge.ros2")

CHANNELS = ["scan", "pose", "stats", "log", "status"]

# FAST-LIO2 topics (match slam_bringup's fast_lio.launch.py).
# /cloud_registered is the WORLD-frame cloud — the wire protocol requires scan
# points in map frame. /cloud_registered_body (body frame) is RTABMap's input,
# not ours.
SCAN_TOPIC = "/cloud_registered"
ODOM_TOPIC = "/Odometry"  # FAST-LIO2 pose @ ~10 Hz


class Ros2Bridge:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.server = BridgeServer(
            server_name="ros2", channels=CHANNELS, app_version="0.1.0",
            command_handler=self.on_command)
        self.loop: asyncio.AbstractEventLoop | None = None

    # -- ROS side (background thread) ---------------------------------------

    def ros_thread(self) -> None:
        import rclpy  # lazy: only the Jetson has this
        from nav_msgs.msg import Odometry
        from sensor_msgs.msg import PointCloud2

        rclpy.init()
        node = rclpy.create_node("viewer_bridge")
        node.create_subscription(PointCloud2, SCAN_TOPIC, self.on_scan, 10)
        node.create_subscription(Odometry, ODOM_TOPIC, self.on_odom, 50)
        log.info("rclpy spinning: %s, %s", SCAN_TOPIC, ODOM_TOPIC)
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
    parser.add_argument("--decimate", type=int, default=1,
                        help="keep every k-th scan point")
    parser.add_argument("--intensity-scale", type=float, default=1.0 / 255.0,
                        help="raw intensity -> 0..1 (default 1/255 for Livox reflectivity)")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    try:
        asyncio.run(Ros2Bridge(args).run())
    except KeyboardInterrupt:
        log.info("bye")


if __name__ == "__main__":
    main()
