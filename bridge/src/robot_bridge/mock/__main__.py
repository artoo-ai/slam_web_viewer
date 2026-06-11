"""Mock bridge CLI — synthesizes the full wire protocol with zero ROS2.

    uv run python -m robot_bridge.mock [--host 127.0.0.1] [--port 9090]
        [--scan-hz 10] [--pose-hz 20] [--points 30000] [--speed 0.4] [--seed 42]
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import time

import numpy as np

from .. import protocol
from ..server import BridgeServer, Client
from .scan import ScanSynthesizer
from .trajectory import LOOP_LENGTH, pose_at
from .world import build_world

log = logging.getLogger("robot_bridge.mock")

CHANNELS = ["scan", "pose", "stats", "log", "status"]


class MockBridge:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.server = BridgeServer(
            server_name="mock", channels=CHANNELS, app_version="0.1.0",
            command_handler=self.on_command)
        planes, boxes, cylinders = build_world()
        self.synth = ScanSynthesizer(planes, boxes, cylinders,
                                     np.random.default_rng(args.seed))
        self.t0 = time.time()
        self.total_pts = 0
        self.last_lap = 0
        self.scan_count = 0

    # -- distance traveled at "now", at constant --speed
    def distance(self) -> float:
        return (time.time() - self.t0) * self.args.speed

    async def on_command(self, cmd: dict, client: Client) -> None:
        match cmd.get("cmd"):
            case "ping":
                await self.server.reply_ack(
                    client, protocol.pong_payload(cmd.get("id", 0), cmd.get("t", 0.0)))
            case "set_param":
                # mock accepts everything verbatim
                await self.server.reply_ack(client, protocol.param_ack_payload(
                    cmd.get("id", 0), cmd.get("node", ""), cmd.get("params", {}), {}))
                self.server.broadcast(protocol.CH_LOG, protocol.log_payload(
                    "info", f"set_param {cmd.get('node')}: {cmd.get('params')}"))
            case other:
                log.info("ignoring unknown command %r", other)

    async def scan_loop(self):
        period = 1.0 / self.args.scan_hz
        while True:
            start = time.monotonic()
            pos, _, _ = pose_at(self.distance())
            if self.server.clients:
                xyzi = self.synth.scan(pos, self.args.points)
                self.total_pts += len(xyzi)
                self.scan_count += 1
                self.server.broadcast(protocol.CH_SCAN, protocol.pack_scan(xyzi))
            await asyncio.sleep(max(0.0, period - (time.monotonic() - start)))

    async def pose_loop(self):
        period = 1.0 / self.args.pose_hz
        while True:
            pos, q, lap = pose_at(self.distance())
            self.server.broadcast(protocol.CH_POSE,
                                  protocol.pose_payload(tuple(pos), tuple(q)))
            if lap > self.last_lap:
                self.last_lap = lap
                self.server.broadcast(protocol.CH_STATUS,
                                      protocol.status_payload("loop_closure"))
                self.server.broadcast(protocol.CH_LOG, protocol.log_payload(
                    "info", f"loop closure: lap {lap} complete "
                            f"({lap * LOOP_LENGTH:.1f} m traveled)"))
            await asyncio.sleep(period)

    async def stats_loop(self):
        rng = np.random.default_rng(self.args.seed + 1)
        health = 0.97
        last_scan_count = 0
        while True:
            await asyncio.sleep(1.0)
            dist = self.distance()
            health = float(np.clip(health + rng.normal(0, 0.01), 0.9, 1.0))
            scan_hz = self.scan_count - last_scan_count
            last_scan_count = self.scan_count
            self.server.broadcast(protocol.CH_STATS, protocol.stats_payload(
                keyframes=int(dist / 0.5),
                total_pts=self.total_pts,
                distance_m=round(dist, 2),
                duration_s=round(time.time() - self.t0, 1),
                scan_hz=float(scan_hz),
                health=round(health, 3),
                clients=len(self.server.clients)))

    async def chatter_loop(self):
        """Occasional informational log lines so the log panel has life."""
        messages = [
            ("info", "ikd-tree rebalance complete"),
            ("debug", "keyframe inserted"),
            ("info", "map voxel grid compacted"),
            ("warn", "scan buffer 80% full"),
        ]
        i = 0
        while True:
            await asyncio.sleep(7.0)
            level, message = messages[i % len(messages)]
            self.server.broadcast(protocol.CH_LOG, protocol.log_payload(level, message))
            i += 1

    async def run(self):
        await asyncio.gather(
            self.server.serve_forever(self.args.host, self.args.port),
            self.scan_loop(),
            self.pose_loop(),
            self.stats_loop(),
            self.chatter_loop(),
        )


def main():
    parser = argparse.ArgumentParser(description="Mock robot bridge (no ROS2)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--scan-hz", type=float, default=10.0)
    parser.add_argument("--pose-hz", type=float, default=20.0)
    parser.add_argument("--points", type=int, default=30000)
    parser.add_argument("--speed", type=float, default=0.4, help="m/s along the loop")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    log.info("mock bridge starting on ws://%s:%d (scan %g Hz, %d pts, pose %g Hz)",
             args.host, args.port, args.scan_hz, args.points, args.pose_hz)
    try:
        asyncio.run(MockBridge(args).run())
    except KeyboardInterrupt:
        log.info("bye")


if __name__ == "__main__":
    main()
