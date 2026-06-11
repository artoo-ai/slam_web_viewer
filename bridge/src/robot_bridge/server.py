"""Generic WebSocket bridge server shared by the mock generator and the rclpy bridge.

Backpressure policy (docs/protocol.md): droppable channels (scan, map, depth) are
delivered through a per-client drop-oldest queue of size 1 — a slow client sees a
lower rate but never stalls others and never receives stale frames. Everything else
is sent reliably in order.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from . import protocol

log = logging.getLogger(__name__)

CommandHandler = Callable[[dict, "Client"], Awaitable[None]]


class Client:
    def __init__(self, ws: ServerConnection):
        self.ws = ws
        # drop-oldest slot per droppable send; size 1 keeps only the freshest frame
        self.droppable_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=1)
        self.dropped = 0

    async def send_reliable(self, frame: bytes) -> None:
        await self.ws.send(frame)

    def send_droppable(self, frame: bytes) -> None:
        if self.droppable_queue.full():
            try:
                self.droppable_queue.get_nowait()
                self.dropped += 1
            except asyncio.QueueEmpty:
                pass
        self.droppable_queue.put_nowait(frame)

    async def drain_droppable(self) -> None:
        while True:
            frame = await self.droppable_queue.get()
            await self.ws.send(frame)


class BridgeServer:
    """Owns the client set, per-channel seq counters, and command dispatch."""

    def __init__(self, *, server_name: str, channels: list[str], app_version: str,
                 command_handler: CommandHandler | None = None):
        self.server_name = server_name
        self.channels = channels
        self.app_version = app_version
        self.command_handler = command_handler
        self.clients: set[Client] = set()
        self._seq: dict[str, int] = {}

    def next_seq(self, topic: str) -> int:
        seq = self._seq.get(topic, 0)
        self._seq[topic] = (seq + 1) % protocol.SEQ_WRAP
        return seq

    def broadcast(self, topic: str, data, *, ts: float | None = None) -> None:
        """Encode once, fan out to every client. Safe to call with no clients."""
        if not self.clients:
            self._seq[topic] = (self._seq.get(topic, 0) + 1) % protocol.SEQ_WRAP
            return
        frame = protocol.make_frame(topic, data, self.next_seq(topic), ts)
        droppable = topic in protocol.DROPPABLE_CHANNELS
        for client in list(self.clients):
            if droppable:
                client.send_droppable(frame)
            else:
                asyncio.ensure_future(self._send_safe(client, frame))

    async def _send_safe(self, client: Client, frame: bytes) -> None:
        try:
            await client.send_reliable(frame)
        except ConnectionClosed:
            pass  # handler() cleans up

    async def handler(self, ws: ServerConnection) -> None:
        client = Client(ws)
        self.clients.add(client)
        log.info("client connected (%d total)", len(self.clients))
        drainer = asyncio.ensure_future(client.drain_droppable())
        try:
            await client.send_reliable(protocol.make_frame(
                protocol.CH_HELLO,
                protocol.hello_payload(self.server_name, self.channels, self.app_version),
                self.next_seq(protocol.CH_HELLO)))
            async for raw in ws:
                if not isinstance(raw, bytes):
                    continue
                try:
                    cmd = protocol.parse_command(raw)
                except ValueError:
                    log.warning("ignoring malformed command")
                    continue
                if self.command_handler is not None:
                    await self.command_handler(cmd, client)
        except ConnectionClosed:
            pass
        finally:
            drainer.cancel()
            self.clients.discard(client)
            log.info("client disconnected (%d total, %d frames dropped to it)",
                     len(self.clients), client.dropped)

    async def reply_ack(self, client: Client, data: dict) -> None:
        """Send a cmd_ack frame to one client."""
        try:
            await client.send_reliable(protocol.make_frame(
                protocol.CH_CMD_ACK, data, self.next_seq(protocol.CH_CMD_ACK)))
        except ConnectionClosed:
            pass

    async def serve_forever(self, host: str, port: int) -> None:
        async with serve(self.handler, host, port, max_size=None):
            log.info("listening on ws://%s:%d", host, port)
            await asyncio.Future()
