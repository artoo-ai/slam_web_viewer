"""Generic WebSocket bridge server shared by the mock generator and the rclpy bridge.

Backpressure policy (docs/protocol.md): droppable channels (scan, map, depth) are
delivered through a per-client drop-oldest queue of size 1 — a slow client sees a
lower rate but never stalls others and never receives stale frames. Everything else
is sent reliably in order.
"""

from __future__ import annotations

import asyncio
import logging
import struct
import time
from datetime import datetime
from pathlib import Path
from typing import Awaitable, Callable

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from . import protocol

log = logging.getLogger(__name__)

CommandHandler = Callable[[dict, "Client"], Awaitable[None]]

REC_MAGIC = b"RGUIREC1\n"


class Recorder:
    """Append-only .rec capture of the outgoing wire stream.

    Record layout after the magic header, repeated:
        float64 LE wall-clock ts | uint16 LE topic length | topic utf-8
        | uint32 LE frame length | frame bytes (the exact WS message)
    """

    def __init__(self):
        self._file = None
        self.path: str | None = None

    @property
    def active(self) -> bool:
        return self._file is not None

    def start(self, path: str | None = None) -> str:
        self.stop()
        if not path:
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            path = str(Path("recordings") / f"session_{stamp}.rec")
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._file = open(path, "wb")
        self._file.write(REC_MAGIC)
        self.path = path
        log.info("recording to %s", path)
        return path

    def stop(self) -> str | None:
        path = self.path
        if self._file is not None:
            self._file.close()
            log.info("recording stopped: %s", path)
        self._file = None
        self.path = None
        return path

    def write(self, topic: str, frame: bytes) -> None:
        if self._file is None:
            return
        tb = topic.encode()
        self._file.write(struct.pack("<dH", time.time(), len(tb)) + tb +
                         struct.pack("<I", len(frame)) + frame)


def read_rec(path: str):
    """Yield (ts, topic, frame_bytes) from a .rec file (replay/tests)."""
    with open(path, "rb") as f:
        if f.read(len(REC_MAGIC)) != REC_MAGIC:
            raise ValueError(f"{path} is not a .rec file")
        while True:
            head = f.read(10)
            if len(head) < 10:
                return
            ts, tlen = struct.unpack("<dH", head)
            topic = f.read(tlen).decode()
            (flen,) = struct.unpack("<I", f.read(4))
            yield ts, topic, f.read(flen)


class Client:
    def __init__(self, ws: ServerConnection):
        self.ws = ws
        # one drop-oldest slot PER TOPIC: a slow client keeps only the freshest
        # frame of each droppable channel, and channels never evict each other
        # (scan vs map sharing one slot starved scans entirely).
        self._latest: dict[str, bytes] = {}
        self._pending: set[str] = set()
        self._dirty: asyncio.Queue[str] = asyncio.Queue()
        self.dropped = 0

    async def send_reliable(self, frame: bytes) -> None:
        await self.ws.send(frame)

    def send_droppable(self, topic: str, frame: bytes) -> None:
        self._latest[topic] = frame
        if topic in self._pending:
            self.dropped += 1  # replaced an unsent frame of the same topic
            return
        self._pending.add(topic)
        self._dirty.put_nowait(topic)

    async def drain_droppable(self) -> None:
        while True:
            topic = await self._dirty.get()
            self._pending.discard(topic)
            frame = self._latest.pop(topic, None)
            if frame is not None:
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
        self.recorder = Recorder()

    def next_seq(self, topic: str) -> int:
        seq = self._seq.get(topic, 0)
        self._seq[topic] = (seq + 1) % protocol.SEQ_WRAP
        return seq

    def broadcast(self, topic: str, data, ts: float | None = None) -> None:
        """Encode once, fan out to every client. Safe to call with no clients.

        `ts` must stay positional: the rclpy bridge dispatches via
        loop.call_soon_threadsafe(server.broadcast, topic, data, ts), which
        cannot pass keyword arguments.
        """
        if not self.clients and not self.recorder.active:
            self._seq[topic] = (self._seq.get(topic, 0) + 1) % protocol.SEQ_WRAP
            return
        frame = protocol.make_frame(topic, data, self.next_seq(topic), ts)
        self.recorder.write(topic, frame)
        self.broadcast_encoded(topic, frame)

    def broadcast_encoded(self, topic: str, frame: bytes) -> None:
        """Fan out a pre-encoded frame (replay path — original seq/ts kept)."""
        droppable = topic in protocol.DROPPABLE_CHANNELS
        for client in list(self.clients):
            if droppable:
                client.send_droppable(topic, frame)
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
                if await self._builtin_command(cmd, client):
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

    async def _builtin_command(self, cmd: dict, client: Client) -> bool:
        """Commands every bridge supports: rec_start / rec_stop."""
        match cmd.get("cmd"):
            case "rec_start":
                try:
                    path = self.recorder.start(cmd.get("path"))
                    ok = True
                except OSError as e:
                    log.warning("rec_start failed: %s", e)
                    path, ok = None, False
                await self.reply_ack(client, {
                    "cmd": "rec_ack", "id": cmd.get("id", 0),
                    "recording": ok, "path": path})
                if ok:
                    self.broadcast(protocol.CH_LOG,
                                   protocol.log_payload("info", f"recording to {path}"))
                return True
            case "rec_stop":
                path = self.recorder.stop()
                await self.reply_ack(client, {
                    "cmd": "rec_ack", "id": cmd.get("id", 0),
                    "recording": False, "path": path})
                self.broadcast(protocol.CH_LOG,
                               protocol.log_payload("info", f"recording saved: {path}"))
                return True
        return False

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
