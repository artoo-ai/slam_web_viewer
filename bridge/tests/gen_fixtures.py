"""Generate golden wire-protocol fixtures consumed by both pytest and vitest.

Run manually from bridge/ and commit the output:

    uv run python tests/gen_fixtures.py

Frames use fixed timestamps/seqs so output is deterministic.
"""

import json
from pathlib import Path

import msgpack
import numpy as np

from robot_bridge import protocol

FIXTURES = Path(__file__).parent / "fixtures"

# 4 hand-chosen scan points: origin-ish, +x, -y, and one up high
SCAN_POINTS = [
    [0.0, 0.0, 0.0, 0.0],
    [1.0, 0.0, 0.5, 0.25],
    [0.0, -2.0, 1.0, 0.5],
    [-3.5, 4.25, 2.5, 1.0],
]


def main() -> None:
    FIXTURES.mkdir(exist_ok=True)

    frames: dict[str, bytes] = {
        "hello.bin": protocol.make_frame(
            protocol.CH_HELLO,
            protocol.hello_payload("mock", ["scan", "pose", "stats", "log", "status"], "0.1.0"),
            seq=0, ts=1718000000.0),
        "scan_4pts.bin": protocol.make_frame(
            protocol.CH_SCAN,
            protocol.pack_scan(np.array(SCAN_POINTS, dtype=np.float32)),
            seq=42, ts=1718000001.5),
        "pose.bin": protocol.make_frame(
            protocol.CH_POSE,
            protocol.pose_payload((1.5, -2.0, 0.3), (0.0, 0.0, 0.7071067811865476, 0.7071067811865476)),
            seq=100, ts=1718000002.25),
        "stats.bin": protocol.make_frame(
            protocol.CH_STATS,
            protocol.stats_payload(keyframes=12, total_pts=360000, distance_m=5.5,
                                   duration_s=33.0, scan_hz=10.0, health=0.97, clients=1),
            seq=33, ts=1718000003.0),
        "log.bin": protocol.make_frame(
            protocol.CH_LOG,
            protocol.log_payload("warn", "tracking degraded"),
            seq=7, ts=1718000004.0),
        # 3x2 grid: row 0 = [0, 100, 255], row 1 = [50, 50, 255]
        "grid_3x2.bin": protocol.make_frame(
            protocol.CH_OCCUPANCY_GRID,
            protocol.occupancy_grid_payload(
                width=3, height=2, resolution=0.05, origin=[-1.5, -2.0, 0.0],
                cells=np.array([0, 100, -1, 50, 50, -1], dtype=np.int8)),
            seq=9, ts=1718000005.0),
        "nav_status.bin": protocol.make_frame(
            protocol.CH_NAV_STATUS,
            protocol.nav_status_payload("navigating", goal_id="g-001",
                                        distance_m=2.5, eta_s=6.0),
            seq=3, ts=1718000006.0),
        # browser -> robot command bytes, for the Python side to parse in tests
        "cmd_set_param.bin": msgpack.packb(
            {"cmd": "set_param", "id": 8, "node": "slam", "params": {"voxel_size": 0.1}},
            use_bin_type=True),
        "cmd_send_goal.bin": msgpack.packb(
            {"cmd": "send_goal", "id": 9, "x": 1.5, "y": 2.0, "theta": 0.0,
             "frame": "map"}, use_bin_type=True),
    }

    for name, raw in frames.items():
        (FIXTURES / name).write_bytes(raw)
        print(f"wrote {name} ({len(raw)} bytes)")

    expected = {
        "hello.bin": {
            "topic": "hello", "ts": 1718000000.0, "seq": 0,
            "data": {"protocol": 1, "server": "mock",
                     "channels": ["scan", "pose", "stats", "log", "status"],
                     "app_version": "0.1.0"},
        },
        "scan_4pts.bin": {
            "topic": "scan", "ts": 1718000001.5, "seq": 42,
            "points": SCAN_POINTS,  # data is bin; tests compare decoded float32 values
        },
        "pose.bin": {
            "topic": "pose", "ts": 1718000002.25, "seq": 100,
            "data": {"p": [1.5, -2.0, 0.3],
                     "q": [0.0, 0.0, 0.7071067811865476, 0.7071067811865476],
                     "frame": "map"},
        },
        "stats.bin": {
            "topic": "stats", "ts": 1718000003.0, "seq": 33,
            "data": {"keyframes": 12, "total_pts": 360000, "distance_m": 5.5,
                     "duration_s": 33.0, "scan_hz": 10.0, "health": 0.97, "clients": 1},
        },
        "log.bin": {
            "topic": "log", "ts": 1718000004.0, "seq": 7,
            "data": {"level": "warn", "message": "tracking degraded"},
        },
        "grid_3x2.bin": {
            "topic": "occupancy_grid", "ts": 1718000005.0, "seq": 9,
            "grid": {"width": 3, "height": 2, "resolution": 0.05,
                     "origin": [-1.5, -2.0, 0.0],
                     "cells": [0, 100, 255, 50, 50, 255]},
        },
        "nav_status.bin": {
            "topic": "nav_status", "ts": 1718000006.0, "seq": 3,
            "data": {"state": "navigating", "goal_id": "g-001",
                     "distance_m": 2.5, "eta_s": 6.0},
        },
        "cmd_set_param.bin": {
            "command": {"cmd": "set_param", "id": 8, "node": "slam",
                        "params": {"voxel_size": 0.1}},
        },
        "cmd_send_goal.bin": {
            "command": {"cmd": "send_goal", "id": 9, "x": 1.5, "y": 2.0,
                        "theta": 0.0, "frame": "map"},
        },
    }
    (FIXTURES / "expected.json").write_text(json.dumps(expected, indent=2) + "\n")
    print("wrote expected.json")


if __name__ == "__main__":
    main()
