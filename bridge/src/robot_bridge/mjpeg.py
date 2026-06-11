"""Minimal asyncio MJPEG-over-HTTP server, shared by the mock and rclpy bridges.

Producers call `set_frame(jpeg_bytes)`; each connected browser gets the latest
frame at up to `fps`. One stream path: /stream/rgb. No external HTTP framework —
multipart/x-mixed-replace is simple enough to hand-roll.
"""

from __future__ import annotations

import asyncio
import logging

log = logging.getLogger(__name__)

BOUNDARY = b"robotguiframe"


class MjpegServer:
    """Multi-stream: each named camera is served at /stream/<name> (1–4 cams)."""

    def __init__(self, *, fps: float = 10.0):
        self.fps = fps
        self._streams: dict[str, tuple[bytes, int]] = {}  # name -> (jpeg, frame_no)

    def set_frame(self, jpeg: bytes, name: str = "rgb") -> None:
        _, no = self._streams.get(name, (b"", 0))
        self._streams[name] = (jpeg, no + 1)

    async def _handle(self, reader: asyncio.StreamReader,
                      writer: asyncio.StreamWriter) -> None:
        try:
            request = await asyncio.wait_for(reader.readline(), 5.0)
            while True:  # drain headers
                line = await asyncio.wait_for(reader.readline(), 5.0)
                if line in (b"\r\n", b"\n", b""):
                    break
            path = request.split(b" ")[1] if len(request.split(b" ")) > 1 else b"/"
            if not path.startswith(b"/stream/"):
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
                return
            name = path[len(b"/stream/"):].split(b"?")[0].decode() or "rgb"
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Cache-Control: no-cache, private\r\n"
                b"Pragma: no-cache\r\n"
                b"Access-Control-Allow-Origin: *\r\n"
                b"Content-Type: multipart/x-mixed-replace; boundary=" + BOUNDARY + b"\r\n"
                b"\r\n")
            await writer.drain()
            sent_no = -1
            period = 1.0 / self.fps
            while True:
                frame, no = self._streams.get(name, (None, -1))
                if frame is not None and no != sent_no:
                    sent_no = no
                    writer.write(
                        b"--" + BOUNDARY + b"\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        b"Content-Length: " + str(len(frame)).encode() + b"\r\n"
                        b"\r\n" + frame + b"\r\n")
                    await writer.drain()
                await asyncio.sleep(period)
        except (ConnectionResetError, BrokenPipeError, asyncio.TimeoutError,
                asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()

    async def serve_forever(self, host: str, port: int) -> None:
        server = await asyncio.start_server(self._handle, host, port)
        log.info("MJPEG on http://%s:%d/stream/<name>", host, port)
        async with server:
            await server.serve_forever()
