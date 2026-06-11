"""End-to-end smoke test: start the mock bridge in-process, connect a real
WebSocket client, assert hello-first, scan rate, payload sanity, and command acks."""

import argparse
import asyncio
import time

import msgpack
import numpy as np
import pytest
from websockets.asyncio.client import connect

from robot_bridge import protocol
from robot_bridge.mock.__main__ import MockBridge
from robot_bridge.mock.world import CEILING, ROOM_X, ROOM_Y


def make_args(port: int) -> argparse.Namespace:
    return argparse.Namespace(host="127.0.0.1", port=port, scan_hz=10.0,
                              pose_hz=20.0, points=5000, speed=0.4, seed=42,
                              mjpeg_port=0)


@pytest.fixture
async def mock_url():
    port = 19090
    bridge = MockBridge(make_args(port))
    task = asyncio.ensure_future(bridge.run())
    await asyncio.sleep(0.2)  # let the server bind
    yield f"ws://127.0.0.1:{port}"
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass


@pytest.mark.asyncio
async def test_mock_protocol_flow(mock_url):
    async with connect(mock_url, max_size=None) as ws:
        # 1. hello arrives first
        first = protocol.parse_frame(await asyncio.wait_for(ws.recv(), 2.0))
        assert first["topic"] == "hello"
        assert first["data"]["protocol"] == 1
        assert first["data"]["server"] == "mock"
        assert "scan" in first["data"]["channels"]

        # 2. collect frames for ~1.2 s
        frames = []
        deadline = time.monotonic() + 1.2
        while time.monotonic() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), 0.5)
            except asyncio.TimeoutError:
                break
            frames.append(protocol.parse_frame(raw))

        scans = [f for f in frames if f["topic"] == "scan"]
        poses = [f for f in frames if f["topic"] == "pose"]
        grids = [f for f in frames if f["topic"] == "occupancy_grid"]
        if grids:  # 0.5 Hz — may or may not land in the 1.2 s window
            g = grids[0]["data"]
            cells = protocol.unpack_grid_rle(g["data"], g["width"] * g["height"])
            assert set(np.unique(cells)) <= {0, 100, 255}
            assert (cells != 255).any(), "some cells should be revealed"
        assert 8 <= len(scans) <= 16, f"expected ~10-12 scans in 1.2s, got {len(scans)}"
        assert len(poses) >= 15, f"expected ~24 poses in 1.2s, got {len(poses)}"

        # 3. scan payload sanity
        for f in scans:
            assert len(f["data"]) % protocol.SCAN_STRIDE_BYTES == 0
        pts = protocol.unpack_scan(scans[0]["data"])
        assert len(pts) > 1000  # most of 5000 rays hit the closed room
        # points inside room + corridor bounds (generous margins for noise)
        assert np.all(np.abs(pts[:, 0]) <= ROOM_X / 2 + 3.1)
        assert np.all(np.abs(pts[:, 1]) <= ROOM_Y / 2 + 0.1)
        assert np.all((pts[:, 2] >= -0.1) & (pts[:, 2] <= CEILING + 0.1))
        assert np.all((pts[:, 3] >= 0.0) & (pts[:, 3] <= 1.0))

        # 4. seq increments without gaps per channel
        seqs = [f["seq"] for f in scans]
        assert seqs == list(range(seqs[0], seqs[0] + len(seqs)))

        # 5. ping -> pong with id correlation
        await ws.send(msgpack.packb({"cmd": "ping", "id": 99, "t": 123.0},
                                    use_bin_type=True))
        for _ in range(50):
            f = protocol.parse_frame(await asyncio.wait_for(ws.recv(), 2.0))
            if f["topic"] == "cmd_ack":
                assert f["data"] == {"cmd": "pong", "id": 99, "t": 123.0}
                break
        else:
            pytest.fail("no pong received")

        # 6. set_param -> param_ack accepting everything
        await ws.send(msgpack.packb(
            {"cmd": "set_param", "id": 100, "node": "slam",
             "params": {"voxel_size": 0.2}}, use_bin_type=True))
        for _ in range(50):
            f = protocol.parse_frame(await asyncio.wait_for(ws.recv(), 2.0))
            if f["topic"] == "cmd_ack" and f["data"].get("id") == 100:
                assert f["data"]["cmd"] == "param_ack"
                assert f["data"]["accepted"] == {"voxel_size": 0.2}
                assert f["data"]["rejected"] == {}
                break
        else:
            pytest.fail("no param_ack received")

        # 7. send_goal -> goal_ack accepted, nav_status navigating, then cancel
        await ws.send(msgpack.packb(
            {"cmd": "send_goal", "id": 101, "x": 1.0, "y": 1.0, "theta": 0.0,
             "frame": "map"}, use_bin_type=True))
        goal_id = None
        navigating = False
        for _ in range(200):
            f = protocol.parse_frame(await asyncio.wait_for(ws.recv(), 2.0))
            if f["topic"] == "cmd_ack" and f["data"].get("id") == 101:
                assert f["data"]["cmd"] == "goal_ack"
                assert f["data"]["accepted"] is True
                goal_id = f["data"]["goal_id"]
            elif f["topic"] == "nav_status" and f["data"]["state"] == "navigating":
                assert f["data"]["goal_id"] == goal_id
                assert f["data"]["distance_m"] > 0
                navigating = True
                break
        assert goal_id and navigating, "no goal_ack + navigating status"

        await ws.send(msgpack.packb(
            {"cmd": "cancel_goal", "id": 102, "goal_id": goal_id}, use_bin_type=True))
        canceled = False
        for _ in range(200):
            f = protocol.parse_frame(await asyncio.wait_for(ws.recv(), 2.0))
            if f["topic"] == "cmd_ack" and f["data"].get("id") == 102:
                assert f["data"] == {"cmd": "cancel_ack", "id": 102, "ok": True}
            elif f["topic"] == "nav_status" and f["data"]["state"] == "canceled":
                assert f["data"]["goal_id"] == goal_id
                canceled = True
                break
        assert canceled, "no canceled nav_status after cancel_goal"
