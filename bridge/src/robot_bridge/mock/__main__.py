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
from .grid import RESOLUTION, ExplorationGrid
from .scan import ScanSynthesizer
from .trajectory import LOOP_LENGTH, pose_at
from .world import build_world

log = logging.getLogger("robot_bridge.mock")

CHANNELS = ["scan", "pose", "stats", "log", "status", "occupancy_grid",
            "nav_status", "nav_path", "velocity"]


class MockBridge:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.server = BridgeServer(
            server_name="mock", channels=CHANNELS, app_version="0.1.0",
            command_handler=self.on_command)
        planes, boxes, cylinders = build_world()
        self.synth = ScanSynthesizer(planes, boxes, cylinders,
                                     np.random.default_rng(args.seed))
        self.grid = ExplorationGrid(planes, boxes, cylinders)
        self.t0 = time.time()
        self.total_pts = 0
        self.last_lap = 0
        self.scan_count = 0
        self.goal_seq = 0
        self.active_goal: dict | None = None  # {"goal_id": str, "cancelled": bool}

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
            case "send_goal":
                self.goal_seq += 1
                goal_id = f"g-{self.goal_seq:03d}"
                if self.active_goal is not None:
                    self.active_goal["cancelled"] = True  # preempt previous goal
                self.active_goal = {"goal_id": goal_id, "cancelled": False}
                await self.server.reply_ack(client, protocol.goal_ack_payload(
                    cmd.get("id", 0), goal_id, True))
                asyncio.ensure_future(self._simulate_nav(
                    self.active_goal, cmd.get("x", 0.0), cmd.get("y", 0.0)))
            case "cancel_goal":
                goal = self.active_goal
                ok = goal is not None and not goal["cancelled"] and \
                    cmd.get("goal_id") in (None, goal["goal_id"])
                if ok and goal is not None:
                    goal["cancelled"] = True
                await self.server.reply_ack(
                    client, protocol.cancel_ack_payload(cmd.get("id", 0), ok))
            case other:
                log.info("ignoring unknown command %r", other)

    async def _simulate_nav(self, goal: dict, gx: float, gy: float):
        """Pretend to navigate: nav_status at 2 Hz with shrinking distance, then
        succeeded. The mock robot doesn't actually drive there — its trajectory
        is fixed — this exercises the protocol and UI."""
        goal_id = goal["goal_id"]
        pos, _, _ = pose_at(self.distance())
        total = max(0.5, float(np.hypot(gx - pos[0], gy - pos[1])))
        speed = 0.5  # m/s simulated
        self.server.broadcast(protocol.CH_LOG, protocol.log_payload(
            "info", f"nav goal {goal_id}: ({gx:.2f}, {gy:.2f}), {total:.1f} m away"))
        remaining = total
        while remaining > 0:
            if goal["cancelled"]:
                self.server.broadcast(protocol.CH_NAV_STATUS,
                                      protocol.nav_status_payload("canceled", goal_id))
                self.server.broadcast(protocol.CH_LOG, protocol.log_payload(
                    "warn", f"nav goal {goal_id} canceled"))
                return
            self.server.broadcast(protocol.CH_NAV_STATUS, protocol.nav_status_payload(
                "navigating", goal_id,
                distance_m=round(remaining, 2), eta_s=round(remaining / speed, 1)))
            await asyncio.sleep(0.5)
            remaining -= speed * 0.5
        self.server.broadcast(protocol.CH_NAV_STATUS,
                              protocol.nav_status_payload("succeeded", goal_id))
        self.server.broadcast(protocol.CH_LOG, protocol.log_payload(
            "info", f"nav goal {goal_id} succeeded"))
        if self.active_goal is goal:
            self.active_goal = None

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

    async def grid_loop(self):
        """Reveal the map around the robot and broadcast map + costmap layers —
        simulates slam_toolbox + Nav2 global costmap during exploration."""
        while True:
            pos, _, _ = pose_at(self.distance())
            self.grid.reveal(pos[0], pos[1])
            common = dict(width=self.grid.width, height=self.grid.height,
                          resolution=RESOLUTION, origin=self.grid.origin)
            self.server.broadcast(
                protocol.CH_OCCUPANCY_GRID,
                protocol.occupancy_grid_payload(cells=self.grid.snapshot(), **common))
            self.server.broadcast(
                protocol.CH_OCCUPANCY_GRID,
                protocol.occupancy_grid_payload(cells=self.grid.costmap(),
                                                layer="costmap_global", **common))
            await asyncio.sleep(2.0)

    async def path_loop(self):
        """Fake Nav2 global plan: a curve from the robot to a point ahead on the
        loop, refreshed at 1 Hz."""
        while True:
            d = self.distance()
            ahead = np.linspace(d, d + 2.5, 12)
            poses = np.empty((len(ahead), 3), dtype=np.float32)
            for i, s in enumerate(ahead):
                p, q, _ = pose_at(s)
                poses[i] = (p[0], p[1], 2.0 * np.arctan2(q[2], q[3]))
            self.server.broadcast(protocol.CH_NAV_PATH,
                                  protocol.nav_path_payload(poses))
            await asyncio.sleep(1.0)

    async def velocity_loop(self):
        """cmd vs odom velocities at 10 Hz. Every 20 s, a 3 s 'smear episode':
        commanded spin at 1.0 rad/s while odom reports ~3% of it — the exact
        rf2o-loses-rotation signature the viewer's alarm is built to catch."""
        rng = np.random.default_rng(self.args.seed + 2)
        while True:
            t = time.time() - self.t0
            d = self.distance()
            _, q0, _ = pose_at(d)
            _, q1, _ = pose_at(d + 0.05)
            yaw0 = 2.0 * np.arctan2(q0[2], q0[3])
            yaw1 = 2.0 * np.arctan2(q1[2], q1[3])
            wz = float(np.unwrap([yaw0, yaw1])[1] - yaw0) / (0.05 / self.args.speed)
            in_episode = (t % 20.0) < 3.0
            if in_episode:
                cmd_vx, cmd_wz = 0.0, 1.0
                odom_vx, odom_wz = 0.0, 0.03 + float(rng.normal(0, 0.01))
            else:
                cmd_vx, cmd_wz = self.args.speed, wz
                odom_vx = cmd_vx + float(rng.normal(0, 0.01))
                odom_wz = wz + float(rng.normal(0, 0.02))
            self.server.broadcast(protocol.CH_VELOCITY, protocol.velocity_payload(
                cmd_vx=round(cmd_vx, 3), cmd_wz=round(cmd_wz, 3),
                odom_vx=round(odom_vx, 3), odom_wz=round(odom_wz, 3)))
            await asyncio.sleep(0.1)

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
            self.grid_loop(),
            self.path_loop(),
            self.velocity_loop(),
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
