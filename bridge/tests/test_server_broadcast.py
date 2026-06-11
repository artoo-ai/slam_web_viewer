"""Regression tests for BridgeServer.broadcast call shapes.

The rclpy bridge dispatches frames from the ROS thread with
loop.call_soon_threadsafe(server.broadcast, topic, data, ts) — positional only.
A keyword-only `ts` made every live frame raise TypeError at dispatch
(mock never hit it because it omits ts)."""

import asyncio

import pytest

from robot_bridge import protocol
from robot_bridge.server import BridgeServer, Client


def make_server() -> BridgeServer:
    return BridgeServer(server_name="test", channels=["pose"], app_version="0")


def test_broadcast_accepts_positional_ts():
    server = make_server()
    server.broadcast("pose", {"p": [0, 0, 0]}, 123.456)  # must not raise


@pytest.mark.asyncio
async def test_call_soon_threadsafe_dispatch_reaches_client():
    """Emulate the exact ROS-thread handoff and assert the frame arrives."""
    server = make_server()

    sent: list[bytes] = []

    class FakeWs:
        async def send(self, frame: bytes):
            sent.append(frame)

    client = Client(FakeWs())  # type: ignore[arg-type]
    server.clients.add(client)

    loop = asyncio.get_running_loop()
    loop.call_soon_threadsafe(server.broadcast, "pose",
                              protocol.pose_payload((1, 2, 3), (0, 0, 0, 1)), 99.5)
    await asyncio.sleep(0.05)  # let the callback and the send task run

    assert len(sent) == 1
    frame = protocol.parse_frame(sent[0])
    assert frame["topic"] == "pose"
    assert frame["ts"] == 99.5
    assert frame["data"]["p"] == [1, 2, 3]
