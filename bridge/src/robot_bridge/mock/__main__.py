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
from ..mapacc import MapAccumulator
from ..mjpeg import MjpegServer
from ..server import BridgeServer, Client
from .camera import now_frame
from .grid import RESOLUTION, ExplorationGrid
from .scan import ScanSynthesizer
from .trajectory import LOOP_LENGTH, pose_at
from .world import build_world

log = logging.getLogger("robot_bridge.mock")

CHANNELS = ["scan", "map", "scan_low", "depth", "pose", "stats", "log", "status", "occupancy_grid",
            "nav_status", "nav_path", "velocity", "imu", "objects", "mission",
            "node_params",
            # per-component diagnostics: the mock advertises ALL FIVE so every
            # DiagnosticsCard tab is demoable offline (on hardware only the
            # running stack's tabs populate).
            "rf2o_diag", "fastlio_diag", "slam_toolbox_diag", "nav2_diag",
            "rtabmap_diag"]

# deployed-config audit demo values: max_vel_theta is INTENTIONALLY stale
# (1.5 vs expected 0.6) so the CONFIG ✗ badge and red row are demoable offline
MOCK_NODE_PARAMS = {
    "controller_server": {"FollowPath.max_vel_theta": 1.5,
                          "FollowPath.min_theta_velocity_threshold": 0.05},
    "behavior_server": {"max_rotational_vel": 0.6, "min_rotational_vel": 0.4},
    "velocity_smoother": {"max_velocity": [0.5, 0.3, 0.6]},
    "local_costmap/local_costmap": {"robot_radius": 0.25,
                                    "inflation_layer.inflation_radius": 0.30},
    "global_costmap/global_costmap": {"robot_radius": 0.25,
                                      "inflation_layer.inflation_radius": 0.30},
    "livox_to_scan": {"min_height": 0.15, "max_height": 0.45},
    "slam_toolbox": {"mode": "mapping", "map_file_name": ""},
}

# fake semantic objects scattered in the world: revealed when the robot passes
# within range, like the Roborock object-on-map feature
FAKE_OBJECTS = [
    {"label": "chair", "p": [-3.0, 2.0, 0.0], "confidence": 0.91},
    {"label": "plant", "p": [-1.5, -1.2, 0.0], "confidence": 0.84},
    {"label": "cabinet", "p": [2.6, -2.6, 0.0], "confidence": 0.88},
    {"label": "person", "p": [4.0, 0.5, 0.0], "confidence": 0.76},
]


class MockBridge:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.server = BridgeServer(
            server_name="mock", channels=CHANNELS, app_version="0.1.0",
            command_handler=self.on_command,
            cameras=["rgb", "depth"] if args.mjpeg_port else [],
            on_connect=self.on_client_connect)
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
        self.mjpeg = MjpegServer(fps=10.0) if args.mjpeg_port else None
        self.mapacc = MapAccumulator(voxel_size=0.10)
        self.found_objects: list[dict] = []

    # -- distance traveled at "now", at constant --speed
    def distance(self) -> float:
        return (time.time() - self.t0) * self.args.speed

    async def on_client_connect(self, client: Client) -> None:
        self.server.broadcast(protocol.CH_NODE_PARAMS,
                              protocol.node_params_payload(MOCK_NODE_PARAMS, True))

    async def on_command(self, cmd: dict, client: Client) -> None:
        match cmd.get("cmd"):
            case "get_params":
                await self.server.reply_ack(client, {
                    "cmd": "params_ack", "id": cmd.get("id", 0), "ok": True})
                self.server.broadcast(
                    protocol.CH_NODE_PARAMS,
                    protocol.node_params_payload(MOCK_NODE_PARAMS, True))
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
            case "map_save":
                try:
                    info = await asyncio.to_thread(
                        self.mapacc.save_qpc,
                        cmd.get("path") or f"maps/map_{int(time.time())}.qpc")
                    await self.server.reply_ack(client, {
                        "cmd": "map_save_ack", "id": cmd.get("id", 0), "ok": True, **info})
                    self.server.broadcast(protocol.CH_LOG, protocol.log_payload(
                        "info", f"map saved: {info['path']} "
                                f"({info['points']:,} pts, {info['bytes']/1024:.0f} KiB)"))
                except (ValueError, OSError) as e:
                    await self.server.reply_ack(client, {
                        "cmd": "map_save_ack", "id": cmd.get("id", 0), "ok": False,
                        "message": str(e)})
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
                low = self._scan_low(pos)
                if low is not None:
                    self.server.broadcast(protocol.CH_SCAN_LOW,
                                          protocol.pack_scan(low))
                delta = self.mapacc.add_scan(xyzi)
                if delta is not None:
                    self.server.broadcast(protocol.CH_MAP, protocol.pack_scan(delta))
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

    async def mission_loop(self):
        """Fake frontier exploration status, mirroring slam_bringup's
        /explore/status JSON (state, frontiers, time budget, coverage)."""
        rng = np.random.default_rng(self.args.seed + 4)
        frontiers = 40.0
        while True:
            await asyncio.sleep(1.0)
            t = time.time() - self.t0
            state = "RETURNING" if (t % 90.0) > 75.0 else "EXPLORING"
            frontiers = max(3.0, frontiers + float(rng.normal(0, 2.5)))
            known = int((self.grid.visited & (self.grid.static != -1)).sum())
            self.server.broadcast(protocol.CH_MISSION, protocol.mission_payload(
                state, {
                    "frontier_count": int(frontiers),
                    "time_elapsed_s": round(t, 0),
                    "time_remaining_s": max(0, round(900 - t, 0)),
                    "free_cells_mapped": known,
                }))

    async def objects_loop(self):
        """Reveal fake objects when the robot passes near them, with a synthetic
        camera-crop thumbnail — exercises the Roborock-style object map."""
        import io

        from PIL import Image, ImageDraw

        def make_thumb(label: str) -> bytes:
            img = Image.new("RGB", (160, 120), (30, 36, 46))
            d = ImageDraw.Draw(img)
            d.rectangle([30, 30, 130, 100], outline=(56, 189, 248), width=3)
            d.text((36, 50), label, fill=(213, 221, 232))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=70)
            return buf.getvalue()

        pending = list(FAKE_OBJECTS)
        while True:
            await asyncio.sleep(1.0)
            pos, _, _ = pose_at(self.distance())
            changed = False
            for obj in list(pending):
                if np.hypot(obj["p"][0] - pos[0], obj["p"][1] - pos[1]) < 2.5:
                    pending.remove(obj)
                    self.found_objects.append({
                        "id": f"obj-{len(self.found_objects) + 1}",
                        "label": obj["label"],
                        "confidence": obj["confidence"],
                        "p": obj["p"],
                        "count": 1,
                        "last_seen": time.time(),
                        "thumb": make_thumb(obj["label"]),
                    })
                    changed = True
                    self.server.broadcast(protocol.CH_STATUS, protocol.status_payload(
                        "object_detected", label=obj["label"], count=1))
                    self.server.broadcast(protocol.CH_LOG, protocol.log_payload(
                        "info", f"object detected: {obj['label']} at "
                                f"({obj['p'][0]:.1f}, {obj['p'][1]:.1f})"))
            if changed:
                self.server.broadcast(protocol.CH_OBJECTS,
                                      protocol.objects_payload(self.found_objects))

    async def depth_loop(self):
        """Fake D435 cloud: the forward ±34° sector of a scan, colored by
        height — exercises the rgb depth layer without hardware."""
        while True:
            await asyncio.sleep(0.2)
            if not self.server.clients:
                continue
            d = self.distance()
            pos, q, _ = pose_at(d)
            yaw = 2.0 * np.arctan2(q[2], q[3])
            pts = self.synth.scan(pos, 6000)
            rel = np.arctan2(pts[:, 1] - pos[1], pts[:, 0] - pos[0]) - yaw
            rel = np.arctan2(np.sin(rel), np.cos(rel))
            rng = np.hypot(pts[:, 0] - pos[0], pts[:, 1] - pos[1])
            sel = pts[(np.abs(rel) < 0.6) & (rng < 5.0)]
            if len(sel) == 0:
                continue
            out = np.empty((len(sel), 6), dtype=np.float32)
            out[:, :3] = sel[:, :3]
            t = np.clip(sel[:, 2] / 2.5, 0, 1)
            out[:, 3] = 0.3 + 0.7 * t          # warm high
            out[:, 4] = 0.5 - 0.2 * t
            out[:, 5] = 1.0 - 0.8 * t          # cool low
            self.server.broadcast(protocol.CH_DEPTH, protocol.pack_xyzrgb(out))

    async def imu_loop(self):
        """IMU at 10 Hz from trajectory derivatives: gyro = quaternion rate,
        accel = gravity + centripetal-ish wobble + noise."""
        rng = np.random.default_rng(self.args.seed + 3)
        dt = 0.05 / self.args.speed
        while True:
            d = self.distance()
            _, q0, _ = pose_at(d)
            _, q1, _ = pose_at(d + 0.05)
            yaw0, yaw1 = (2.0 * np.arctan2(q[2], q[3]) for q in (q0, q1))
            wz = float(np.unwrap([yaw0, yaw1])[1] - yaw0) / dt
            gyro = (float(rng.normal(0, 0.01)), float(rng.normal(0, 0.01)),
                    wz + float(rng.normal(0, 0.02)))
            accel = (float(rng.normal(0, 0.05)),
                     float(wz * self.args.speed + rng.normal(0, 0.05)),
                     9.81 + float(rng.normal(0, 0.08)))
            self.server.broadcast(protocol.CH_IMU, protocol.imu_payload(
                angular_vel=gyro, linear_accel=accel))
            await asyncio.sleep(0.1)

    async def diag_loop(self):
        """Synthetic per-component diagnostics for all five DiagnosticsCard tabs.
        Aligns a fault episode with the velocity smear window (every 20 s, for
        3 s) so rf2o reads low-rate + jumping and Nav2 fires a recovery —
        exercising the panels' alarm states offline."""
        rng = np.random.default_rng(self.args.seed + 5)
        loop_total = 0
        proximity = 0
        recoveries = 0
        last_recovery = None
        updates = 0
        while True:
            await asyncio.sleep(1.0)
            t = time.time() - self.t0
            d = self.distance()
            pos, q, _ = pose_at(d)
            _, q1, _ = pose_at(d + 0.05)
            yaw = 2.0 * float(np.arctan2(q[2], q[3]))
            yaw1 = 2.0 * float(np.arctan2(q1[2], q1[3]))
            wz = float(np.unwrap([yaw, yaw1])[1] - yaw) / (0.05 / self.args.speed)
            in_episode = (t % 20.0) < 3.0
            if in_episode:
                vx, wz = 0.0, 0.03
            else:
                vx = self.args.speed
            # rf2o: drops to ~2 Hz and jumps during the fault episode
            rf2o_hz = 2.0 if in_episode else 12.0 + float(rng.normal(0, 0.4))
            self.server.broadcast(protocol.CH_RF2O_DIAG, protocol.odom_diag_payload(
                source="rf2o", hz=round(rf2o_hz, 1),
                pose=(float(pos[0]), float(pos[1]), yaw), vel=(round(vx, 3), round(wz, 3)),
                cov_trace=round(0.02 + abs(float(rng.normal(0, 0.005))), 4),
                jump=bool(in_episode and (t % 20.0) > 2.0),
                age_s=round(1.0 / max(rf2o_hz, 0.1), 2)))
            # fast-lio2: steady, high-rate, no covariance reported
            self.server.broadcast(protocol.CH_FASTLIO_DIAG, protocol.odom_diag_payload(
                source="fastlio", hz=round(48.0 + float(rng.normal(0, 1.0)), 1),
                pose=(float(pos[0]), float(pos[1]), yaw),
                vel=(round(self.args.speed, 3), round(wz, 3)),
                cov_trace=None, jump=False, age_s=0.02))
            # slam_toolbox: growing pose-graph + small drifting correction
            updates += 1
            nodes = int(d / 0.3)
            known = int((self.grid.visited & (self.grid.static != -1)).sum())
            self.server.broadcast(
                protocol.CH_SLAM_TOOLBOX_DIAG, protocol.slam_toolbox_diag_payload(
                    map_info={"w": self.grid.width, "h": self.grid.height,
                              "res": RESOLUTION,
                              "known_m2": round(known * RESOLUTION ** 2, 1),
                              "updates": updates, "update_hz": 0.5},
                    graph={"nodes": nodes, "edges": max(0, nodes - 1 + self.last_lap)},
                    correction={"dist_m": round(abs(float(rng.normal(0, 0.03))), 3),
                                "yaw_deg": round(abs(float(rng.normal(0, 1.0))), 2)},
                    mode="mapping"))
            # nav2: recovery burst when navigating during the fault episode
            if self.active_goal and in_episode and rng.random() < 0.5:
                recoveries += 1
                last_recovery = "Spin"
            state = "navigating" if self.active_goal else "idle"
            self.server.broadcast(protocol.CH_NAV2_DIAG, protocol.nav2_diag_payload(
                state=state,
                bt_node=("Spin" if (self.active_goal and in_episode)
                         else "FollowPath" if self.active_goal else "Idle"),
                recoveries={"total": recoveries, "last": last_recovery},
                plan_poses=12 if self.active_goal else 0,
                cmd={"vx": round(vx, 3), "wz": round(wz, 3)},
                servers={"planner": True, "controller": True}))
            # rtabmap: occasional loop closures, plausible timing/memory
            if rng.random() < 0.15:
                loop_total += 1
                if rng.random() < 0.5:
                    proximity += 1
            self.server.broadcast(protocol.CH_RTABMAP_DIAG, protocol.rtabmap_diag_payload(
                loop_total=loop_total,
                loop_last_id=int(d * 3) if loop_total else None,
                proximity=proximity, ref_id=int(d * 3),
                proc_ms=round(30.0 + float(rng.normal(0, 5)), 1),
                wm_size=80 + nodes, words=300 + int(rng.random() * 80),
                localized=True))

    async def camera_loop(self):
        # frames render regardless of WS clients — MJPEG has its own consumers.
        # Two streams exercise the viewer's multi-camera strip.
        import io

        from PIL import Image, ImageOps

        frame_no = 0
        while True:
            jpeg = now_frame(self.t0, frame_no)
            self.mjpeg.set_frame(jpeg, "rgb")
            if frame_no % 2 == 0:  # fake "depth" at half rate: inverted grayscale
                img = ImageOps.invert(Image.open(io.BytesIO(jpeg)).convert("L"))
                buf = io.BytesIO()
                img.convert("RGB").save(buf, format="JPEG", quality=70)
                self.mjpeg.set_frame(buf.getvalue(), "depth")
            frame_no += 1
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
        loops = [
            self.server.serve_forever(self.args.host, self.args.port),
            self.scan_loop(),
            self.pose_loop(),
            self.stats_loop(),
            self.grid_loop(),
            self.path_loop(),
            self.velocity_loop(),
            self.imu_loop(),
            self.depth_loop(),
            self.mission_loop(),
            self.objects_loop(),
            self.chatter_loop(),
            self.diag_loop(),
        ]
        if self.mjpeg is not None:
            loops += [self.mjpeg.serve_forever(self.args.host, self.args.mjpeg_port),
                      self.camera_loop()]
        await asyncio.gather(*loops)



    # Synthetic dog bowl: a 14 cm ring of low-band returns at a fixed spot
    # near the trajectory, visible only within 4 m (mirrors the real
    # /scan_low marking range). Demoes the GUI's Low Obstacles layer.
    _BOWL = (1.8, -1.2)

    def _scan_low(self, pos):
        import numpy as np
        bx, by = self._BOWL
        if (pos[0] - bx) ** 2 + (pos[1] - by) ** 2 > 16.0:
            return None
        th = np.random.default_rng().uniform(0, 2 * np.pi, 40)
        x = bx + 0.07 * np.cos(th)
        y = by + 0.07 * np.sin(th)
        z = np.full_like(x, 0.08)
        i = np.full_like(x, 0.6)
        return np.column_stack([x, y, z, i]).astype(np.float32)


def main():
    parser = argparse.ArgumentParser(description="Mock robot bridge (no ROS2)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--scan-hz", type=float, default=10.0)
    parser.add_argument("--pose-hz", type=float, default=20.0)
    parser.add_argument("--points", type=int, default=30000)
    parser.add_argument("--speed", type=float, default=0.4, help="m/s along the loop")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--mjpeg-port", type=int, default=8080,
                        help="MJPEG camera port (0 disables)")
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
