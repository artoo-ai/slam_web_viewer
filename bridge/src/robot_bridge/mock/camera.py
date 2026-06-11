"""Synthetic camera frames for the mock MJPEG stream (Pillow)."""

from __future__ import annotations

import io
import math
import time

from PIL import Image, ImageDraw

W, H = 640, 480


def make_frame(t: float, frame_no: int) -> bytes:
    """A moving scene: gradient sky, scrolling floor lines, bouncing ball,
    frame counter — enough motion to verify latency and continuity by eye."""
    img = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(img)
    for y in range(0, H, 4):  # vertical gradient
        shade = int(20 + 60 * y / H)
        draw.rectangle([0, y, W, y + 4], fill=(shade // 2, shade, shade + 30))
    horizon = H // 2
    draw.rectangle([0, horizon, W, H], fill=(38, 34, 30))
    for i in range(8):  # scrolling floor lines (fake forward motion)
        phase = (t * 0.7 + i / 8.0) % 1.0
        y = horizon + int(phase**2 * (H - horizon))
        draw.line([0, y, W, y], fill=(70, 62, 52), width=max(1, int(phase * 4)))
    bx = W / 2 + math.sin(t * 1.3) * W / 3
    by = H / 2 + math.cos(t * 0.9) * H / 5
    draw.ellipse([bx - 25, by - 25, bx + 25, by + 25], fill=(245, 158, 11))
    draw.text((10, 10), f"mock rgb  frame {frame_no}  t={t:6.1f}s", fill=(213, 221, 232))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


def now_frame(t0: float, frame_no: int) -> bytes:
    return make_frame(time.time() - t0, frame_no)
