"""Wire protocol v1 — see docs/protocol.md (the source of truth).

Frame envelope (robot -> browser), one MessagePack map per WebSocket binary message:

    { "topic": str, "ts": float, "seq": uint32, "data": bin | map }

All binary numeric payloads are little-endian float32. Coordinates are REP-103
(x forward, y left, z up), meters.
"""

from __future__ import annotations

import time
from typing import Any

import msgpack
import numpy as np

PROTOCOL_VERSION = 1

# Implemented channels
CH_HELLO = "hello"
CH_SCAN = "scan"
CH_POSE = "pose"
CH_STATS = "stats"
CH_LOG = "log"
CH_STATUS = "status"
CH_CMD_ACK = "cmd_ack"

# Reserved channels (documented in docs/protocol.md, implemented in later slices)
RESERVED_CHANNELS = (
    "map",
    "depth",
    "imu",
    "detections",
    "processing",
    "velocity",
    "loop_closure",
    "occupancy_grid",
    "nav_path",
    "nav_status",
)

# Channels that must be dropped (never queued) on client backpressure
DROPPABLE_CHANNELS = frozenset({CH_SCAN, "map", "depth"})

SCAN_STRIDE_BYTES = 16  # float32 x, y, z, intensity

SEQ_WRAP = 2**32


def make_frame(topic: str, data: Any, seq: int, ts: float | None = None) -> bytes:
    """Encode one wire frame. `data` is bytes (bin payload) or a dict (map payload)."""
    return msgpack.packb(
        {
            "topic": topic,
            "ts": time.time() if ts is None else ts,
            "seq": seq % SEQ_WRAP,
            "data": data,
        },
        use_bin_type=True,
    )


def parse_frame(raw: bytes) -> dict:
    """Decode one wire frame (used by tests and debug clients)."""
    frame = msgpack.unpackb(raw, raw=False)
    if not isinstance(frame, dict) or "topic" not in frame:
        raise ValueError("not a protocol frame")
    return frame


def parse_command(raw: bytes) -> dict:
    """Decode a browser -> robot command. Commands are msgpack maps with 'cmd' and 'id'."""
    cmd = msgpack.unpackb(raw, raw=False)
    if not isinstance(cmd, dict) or "cmd" not in cmd:
        raise ValueError("not a protocol command")
    return cmd


def pack_scan(xyzi: np.ndarray) -> bytes:
    """Pack an (N, 4) float32 array of [x, y, z, intensity] into the scan bin payload."""
    if xyzi.dtype != np.float32:
        raise ValueError(f"scan must be float32, got {xyzi.dtype}")
    if xyzi.ndim != 2 or xyzi.shape[1] != 4:
        raise ValueError(f"scan must have shape (N, 4), got {xyzi.shape}")
    if not xyzi.flags.c_contiguous:
        xyzi = np.ascontiguousarray(xyzi)
    return xyzi.tobytes()


def unpack_scan(data: bytes) -> np.ndarray:
    """Inverse of pack_scan (tests / debug)."""
    if len(data) % SCAN_STRIDE_BYTES != 0:
        raise ValueError(f"scan payload length {len(data)} not a multiple of {SCAN_STRIDE_BYTES}")
    return np.frombuffer(data, dtype=np.float32).reshape(-1, 4)


# ---------------------------------------------------------------------------
# Payload builders (map payloads)
# ---------------------------------------------------------------------------

def hello_payload(server: str, channels: list[str], app_version: str) -> dict:
    return {
        "protocol": PROTOCOL_VERSION,
        "server": server,
        "channels": channels,
        "app_version": app_version,
    }


def pose_payload(p: tuple[float, float, float], q: tuple[float, float, float, float],
                 frame: str = "map") -> dict:
    return {"p": list(p), "q": list(q), "frame": frame}


def stats_payload(*, keyframes: int, total_pts: int, distance_m: float, duration_s: float,
                  scan_hz: float, health: float, clients: int) -> dict:
    return {
        "keyframes": keyframes,
        "total_pts": total_pts,
        "distance_m": distance_m,
        "duration_s": duration_s,
        "scan_hz": scan_hz,
        "health": health,
        "clients": clients,
    }


def log_payload(level: str, message: str) -> dict:
    return {"level": level, "message": message}


def status_payload(event: str, label: str | None = None, count: int | None = None) -> dict:
    payload: dict = {"event": event}
    if label is not None:
        payload["label"] = label
    if count is not None:
        payload["count"] = count
    return payload


def param_ack_payload(cmd_id: int, node: str, accepted: dict, rejected: dict) -> dict:
    return {"cmd": "param_ack", "id": cmd_id, "node": node,
            "accepted": accepted, "rejected": rejected}


def pong_payload(cmd_id: int, t: float) -> dict:
    return {"cmd": "pong", "id": cmd_id, "t": t}
