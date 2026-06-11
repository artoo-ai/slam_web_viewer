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
    def __init__(self, *, fps: float = 10.0):
        self.fps = fps
        self._frame: bytes | None = None
        self._frame_no = 0

    def set_frame(self, jpeg: bytes) -> None:
        self._frame = jpeg
        self._frame_no += 1

    async def _handle(self, reader: asyncio.StreamReader,
                      writer: asyncio.StreamWriter) -> None:
        try:
            request = await asyncio.wait_for(reader.readline(), 5.0)
            while True:  # drain headers
                line = await asyncio.wait_for(reader.readline(), 5.0)
                if line in (b"\r\n", b"\n", b""):
                    break
            path = request.split(b" ")[1] if len(request.split(b" ")) > 1 else b"/"
            if not path.startswith(b"/stream"):
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
                return
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
                if self._frame is not None and self._frame_no != sent_no:
                    sent_no = self._frame_no
                    writer.write(
                        b"--" + BOUNDARY + b"\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        b"Content-Length: " + str(len(self._frame)).encode() + b"\r\n"
                        b"\r\n" + self._frame + b"\r\n")
                    await writer.drain()
                await asyncio.sleep(period)
        except (ConnectionResetError, BrokenPipeError, asyncio.TimeoutError,
                asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()

    async def serve_forever(self, host: str, port: int) -> None:
        server = await asyncio.start_server(self._handle, host, port)
        log.info("MJPEG on http://%s:%d/stream/rgb", host, port)
        async with server:
            await server.serve_forever()
