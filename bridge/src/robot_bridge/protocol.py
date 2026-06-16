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
CH_IMU = "imu"
CH_MAP = "map"  # accumulated-map delta: bin float32 [x,y,z,intensity]*N, map frame
CH_DEPTH = "depth"  # depth-camera cloud: bin float32 [x,y,z,r,g,b]*N (stride 24)
CH_OBJECTS = "objects"  # persistent semantic objects with thumbnails
CH_MISSION = "mission"  # high-level mission/exploration state
CH_NODE_PARAMS = "node_params"  # deployed-config audit (docs/diagnostics.md §1)
CH_SCAN_LOW = "scan_low"  # low obstacle band (0.05-0.15 m) laserscan, map frame — same packing as scan

# Per-component SLAM diagnostics (docs/protocol.md §diagnostics). Map payloads,
# reliable, low-rate (1-2 Hz). rf2o (2d) and fastlio (3d) share one builder
# shape (odom_diag_payload) — they are the same /odom subscription per stack.
CH_RF2O_DIAG = "rf2o_diag"            # 2D laser odometry health (stack=2d)
CH_FASTLIO_DIAG = "fastlio_diag"      # FAST-LIO2 odometry health (stack=3d)
CH_SLAM_TOOLBOX_DIAG = "slam_toolbox_diag"  # map + pose-graph + map->odom correction
CH_NAV2_DIAG = "nav2_diag"            # BT node, recoveries, plan, controller cmd
CH_RTABMAP_DIAG = "rtabmap_diag"      # loop closures, processing time, memory

GRID_LAYERS = ("map", "costmap_global", "costmap_local")

# Reserved channels (documented in docs/protocol.md, implemented in later slices)
RESERVED_CHANNELS = (
    "detections",
    "processing",
    "loop_closure",
)

DEPTH_STRIDE_BYTES = 24  # float32 x, y, z, r, g, b

NAV_STATES = ("accepted", "navigating", "succeeded", "aborted", "canceled", "rejected")

# Channels that must be dropped (never queued) on client backpressure
DROPPABLE_CHANNELS = frozenset({CH_SCAN, CH_SCAN_LOW, "map", "depth"})

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


def pack_xyzrgb(pts: np.ndarray) -> bytes:
    """Pack an (N, 6) float32 [x,y,z,r,g,b] array into the depth bin payload."""
    if pts.dtype != np.float32:
        raise ValueError(f"depth cloud must be float32, got {pts.dtype}")
    if pts.ndim != 2 or pts.shape[1] != 6:
        raise ValueError(f"depth cloud must have shape (N, 6), got {pts.shape}")
    if not pts.flags.c_contiguous:
        pts = np.ascontiguousarray(pts)
    return pts.tobytes()


def unpack_scan(data: bytes) -> np.ndarray:
    """Inverse of pack_scan (tests / debug)."""
    if len(data) % SCAN_STRIDE_BYTES != 0:
        raise ValueError(f"scan payload length {len(data)} not a multiple of {SCAN_STRIDE_BYTES}")
    return np.frombuffer(data, dtype=np.float32).reshape(-1, 4)


# ---------------------------------------------------------------------------
# Payload builders (map payloads)
# ---------------------------------------------------------------------------

def hello_payload(server: str, channels: list[str], app_version: str,
                  cameras: list[str] | None = None) -> dict:
    payload = {
        "protocol": PROTOCOL_VERSION,
        "server": server,
        "channels": channels,
        "app_version": app_version,
    }
    if cameras:
        payload["cameras"] = cameras  # MJPEG stream names at :8080/stream/<name>
    return payload


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


def node_params_payload(nodes: dict, complete: bool, stamp: float | None = None) -> dict:
    """Deployed-config audit snapshot: {node: {param: value} | None}.

    A node that didn't respond is None (UI renders UNKNOWN, never OK) and
    flips `complete` to False.
    """
    import time as _time
    return {"stamp": _time.time() if stamp is None else stamp,
            "complete": complete, "nodes": nodes}


def mission_payload(state: str, fields: dict | None = None) -> dict:
    """High-level mission status (e.g. frontier exploration).

    `state` is a short machine state ("EXPLORING", "RETURNING", "IDLE", ...);
    `fields` is a flat map of display values (numbers/strings) the viewer
    renders as rows — keys are free-form so any mission node can feed it.
    """
    return {"state": state, "fields": fields or {}}


def objects_payload(objects: list[dict]) -> dict:
    """Persistent semantic object memory (full list — it stays small).

    Each object: { "id": str, "label": str, "confidence": float,
                   "p": [x, y, z] (map frame), "count": uint,
                   "last_seen": float (epoch s), "thumb": bin (JPEG) | absent }
    """
    return {"objects": objects}


def imu_payload(*, angular_vel: tuple[float, float, float],
                linear_accel: tuple[float, float, float],
                orientation: tuple[float, float, float, float] | None = None) -> dict:
    payload: dict = {"angular_vel": list(angular_vel),
                     "linear_accel": list(linear_accel)}
    if orientation is not None:
        payload["orientation"] = list(orientation)
    return payload


def param_ack_payload(cmd_id: int, node: str, accepted: dict, rejected: dict,
                      reasons: dict | None = None) -> dict:
    payload = {"cmd": "param_ack", "id": cmd_id, "node": node,
               "accepted": accepted, "rejected": rejected}
    if reasons:
        payload["reasons"] = reasons  # param -> node's rejection reason string
    return payload


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


# ---------------------------------------------------------------------------
# Per-component SLAM diagnostics payloads
# ---------------------------------------------------------------------------

def odom_diag_payload(*, source: str, hz: float,
                      pose: tuple[float, float, float],
                      vel: tuple[float, float],
                      cov_trace: float | None, jump: bool, age_s: float) -> dict:
    """Odometry health, shared by rf2o (2d) and FAST-LIO2 (3d).

    `source` distinguishes them ("rf2o" | "fastlio"); `hz` is the measured
    publish rate (0 = odometry dead); `pose` is [x, y, yaw]; `vel` is body
    [vx, wz]; `cov_trace` is the pose covariance trace if the publisher fills
    one (None otherwise); `jump` flags a between-samples position jump
    (divergence / SLAM correction); `age_s` is seconds since the last message.
    """
    return {"source": source, "hz": hz, "pose": list(pose),
            "vel": {"vx": vel[0], "wz": vel[1]},
            "cov_trace": cov_trace, "jump": jump, "age_s": age_s}


def slam_toolbox_diag_payload(*, map_info: dict | None, graph: dict | None,
                              correction: dict | None, mode: str | None) -> dict:
    """slam_toolbox health: map dims/coverage, pose-graph size, map->odom
    correction magnitude, and mapping/localization mode.

    `map_info`: {w, h, res, known_m2, updates, update_hz} or None until a map
    arrives. `graph`: {nodes, edges} or None until the graph viz is seen.
    `correction`: {dist_m, yaw_deg} latest map->odom delta, or None.
    """
    return {"map": map_info, "graph": graph,
            "correction": correction, "mode": mode}


def nav2_diag_payload(*, state: str, bt_node: str | None, recoveries: dict,
                      plan_poses: int, cmd: dict,
                      servers: dict | None) -> dict:
    """Nav2 health: composed state ("idle"/"navigating"/...), the active
    behavior-tree leaf, recovery actions counted ({total, last}), the current
    global plan length, the latest controller command, and server liveness.
    """
    return {"state": state, "bt_node": bt_node, "recoveries": recoveries,
            "plan_poses": plan_poses, "cmd": cmd, "servers": servers}


def rtabmap_diag_payload(*, loop_total: int, loop_last_id: int | None,
                         proximity: int, ref_id: int, proc_ms: float | None,
                         wm_size: int | None, words: int | None,
                         localized: bool | None) -> dict:
    """RTAB-Map health from /rtabmap/info: cumulative loop closures and the
    last closure's node id, proximity detections, current node id, per-update
    processing time, working-memory size, current-frame words, and whether a
    recent localization pose was seen. Version-varying fields are None-safe.
    """
    return {"loop_total": loop_total, "loop_last_id": loop_last_id,
            "proximity": proximity, "ref_id": ref_id, "proc_ms": proc_ms,
            "wm_size": wm_size, "words": words, "localized": localized}


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
