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
CH_OCCUPANCY_GRID = "occupancy_grid"
CH_NAV_STATUS = "nav_status"
CH_NAV_PATH = "nav_path"
CH_VELOCITY = "velocity"

GRID_LAYERS = ("map", "costmap_global", "costmap_local")

# Reserved channels (documented in docs/protocol.md, implemented in later slices)
RESERVED_CHANNELS = (
    "map",
    "depth",
    "imu",
    "detections",
    "processing",
    "loop_closure",
)

NAV_STATES = ("accepted", "navigating", "succeeded", "aborted", "canceled", "rejected")

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


def pack_grid_rle(cells: np.ndarray) -> bytes:
    """RLE-encode an occupancy grid (flat int8/uint8 array, row-major).

    Records of 3 bytes: [uint8 value, uint16 LE run_length], run_length 1..65535.
    int8 -1 (ROS unknown) is stored as uint8 255.
    """
    if cells.ndim != 1:
        raise ValueError(f"grid must be flat, got shape {cells.shape}")
    if cells.dtype not in (np.int8, np.uint8):
        raise ValueError(f"grid must be int8/uint8, got {cells.dtype}")
    vals = cells.view(np.uint8)
    if len(vals) == 0:
        return b""
    # run boundaries
    edges = np.flatnonzero(np.diff(vals)) + 1
    starts = np.concatenate(([0], edges))
    lengths = np.diff(np.concatenate((starts, [len(vals)])))
    out = bytearray()
    for value, length in zip(vals[starts], lengths):
        length = int(length)
        while length > 0:
            chunk = min(length, 0xFFFF)
            out.append(int(value))
            out += chunk.to_bytes(2, "little")
            length -= chunk
    return bytes(out)


def unpack_grid_rle(data: bytes, n_cells: int) -> np.ndarray:
    """Inverse of pack_grid_rle -> flat uint8 array (255 = unknown). Tests/debug."""
    if len(data) % 3 != 0:
        raise ValueError(f"RLE payload length {len(data)} not a multiple of 3")
    records = np.frombuffer(data, dtype=np.uint8).reshape(-1, 3)
    values = records[:, 0]
    lengths = records[:, 1].astype(np.uint32) | (records[:, 2].astype(np.uint32) << 8)
    out = np.repeat(values, lengths)
    if len(out) != n_cells:
        raise ValueError(f"RLE decoded {len(out)} cells, expected {n_cells}")
    return out


def occupancy_grid_payload(*, width: int, height: int, resolution: float,
                           origin: tuple[float, float, float],
                           cells: np.ndarray, layer: str = "map") -> dict:
    """Build the occupancy_grid map payload from flat row-major int8/uint8 cells."""
    if layer not in GRID_LAYERS:
        raise ValueError(f"unknown grid layer {layer!r}")
    return {
        "layer": layer,
        "width": width,
        "height": height,
        "resolution": resolution,
        "origin": list(origin),
        "encoding": "rle",
        "data": pack_grid_rle(cells),
    }


def nav_path_payload(poses_xyt: np.ndarray, frame: str = "map") -> dict:
    """Build the nav_path payload from an (N, 3) float32 array of [x, y, theta].

    An empty array clears the displayed path.
    """
    if poses_xyt.size and (poses_xyt.ndim != 2 or poses_xyt.shape[1] != 3):
        raise ValueError(f"path must have shape (N, 3), got {poses_xyt.shape}")
    data = np.ascontiguousarray(poses_xyt, dtype=np.float32).tobytes()
    return {"frame": frame, "poses": data}


def velocity_payload(*, cmd_vx: float, cmd_wz: float,
                     odom_vx: float, odom_wz: float) -> dict:
    return {"cmd": {"vx": cmd_vx, "wz": cmd_wz},
            "odom": {"vx": odom_vx, "wz": odom_wz}}


def param_ack_payload(cmd_id: int, node: str, accepted: dict, rejected: dict) -> dict:
    return {"cmd": "param_ack", "id": cmd_id, "node": node,
            "accepted": accepted, "rejected": rejected}


def pong_payload(cmd_id: int, t: float) -> dict:
    return {"cmd": "pong", "id": cmd_id, "t": t}


def goal_ack_payload(cmd_id: int, goal_id: str, accepted: bool,
                     message: str | None = None) -> dict:
    payload: dict = {"cmd": "goal_ack", "id": cmd_id, "goal_id": goal_id,
                     "accepted": accepted}
    if message is not None:
        payload["message"] = message
    return payload


def cancel_ack_payload(cmd_id: int, ok: bool) -> dict:
    return {"cmd": "cancel_ack", "id": cmd_id, "ok": ok}


def nav_status_payload(state: str, goal_id: str | None = None,
                       distance_m: float | None = None,
                       eta_s: float | None = None,
                       message: str | None = None) -> dict:
    if state not in NAV_STATES:
        raise ValueError(f"unknown nav state {state!r}")
    payload: dict = {"state": state}
    if goal_id is not None:
        payload["goal_id"] = goal_id
    if distance_m is not None:
        payload["distance_m"] = distance_m
    if eta_s is not None:
        payload["eta_s"] = eta_s
    if message is not None:
        payload["message"] = message
    return payload
