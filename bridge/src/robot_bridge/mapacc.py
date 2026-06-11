"""Voxel-deduplicating map accumulator shared by the mock and rclpy bridges.

Feed it map-frame scans; it returns only the points that landed in voxels never
seen before — the `map` channel's incremental delta. Memory is one int64 set
entry per occupied voxel (~50 MB at 100M voxels; a room is thousands).
"""

from __future__ import annotations

import numpy as np


QPC_MAGIC = b"RGQPC1\n"


class MapAccumulator:
    def __init__(self, voxel_size: float = 0.10, max_voxels: int = 5_000_000,
                 retain: bool = True):
        self.voxel_size = voxel_size
        self.max_voxels = max_voxels
        self.retain = retain  # keep delta points for map_save
        self._seen: set[int] = set()
        self._chunks: list[np.ndarray] = []
        self.total_points = 0

    def add_scan(self, xyzi: np.ndarray) -> np.ndarray | None:
        """Return the (M, 4) float32 subset of new-voxel points, or None if empty
        or the voxel budget is exhausted."""
        if len(xyzi) == 0 or len(self._seen) >= self.max_voxels:
            return None
        # pack voxel coords into one int64 (21 bits per axis, offset to positive)
        v = np.floor(xyzi[:, :3] / self.voxel_size).astype(np.int64) + (1 << 20)
        keys = (v[:, 0] << 42) | (v[:, 1] << 21) | v[:, 2]
        # first occurrence of each key within this scan
        _, first_idx = np.unique(keys, return_index=True)
        fresh = [i for i in first_idx if int(keys[i]) not in self._seen]
        if not fresh:
            return None
        self._seen.update(int(keys[i]) for i in fresh)
        delta = np.ascontiguousarray(xyzi[fresh])
        self.total_points += len(delta)
        if self.retain:
            self._chunks.append(delta)
        return delta

    def points(self) -> np.ndarray:
        """All retained map points as one (N, 4) float32 array."""
        if not self._chunks:
            return np.empty((0, 4), dtype=np.float32)
        return np.concatenate(self._chunks)

    def save_qpc(self, path: str) -> dict:
        """Save the retained map as .qpc — quantized compressed point cloud.

        Layout: magic | uint32 count | float64[6] bbox (min xyz, max xyz)
        | zlib(uint16 x,y,z quantized to bbox + uint8 intensity, per point).
        ~4-6 bytes/point on disk vs 16 raw; quantization error <= extent/65535
        (sub-millimeter at building scale).
        """
        import zlib
        from pathlib import Path

        pts = self.points()
        if len(pts) == 0:
            raise ValueError("map is empty")
        lo = pts[:, :3].min(axis=0).astype(np.float64)
        hi = pts[:, :3].max(axis=0).astype(np.float64)
        extent = np.maximum(hi - lo, 1e-6)
        q = np.empty((len(pts), 3), dtype=np.uint16)
        q[:] = np.round((pts[:, :3] - lo) / extent * 65535.0)
        inten = np.clip(pts[:, 3] * 255.0, 0, 255).astype(np.uint8)
        payload = zlib.compress(
            np.concatenate([q.view(np.uint8).reshape(len(pts), 6),
                            inten[:, None]], axis=1).tobytes(), level=6)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as f:
            f.write(QPC_MAGIC)
            f.write(np.uint32(len(pts)).tobytes())
            f.write(np.concatenate([lo, hi]).tobytes())
            f.write(payload)
        size = len(QPC_MAGIC) + 4 + 48 + len(payload)
        return {"path": path, "points": int(len(pts)), "bytes": size}


def load_qpc(path: str) -> np.ndarray:
    """Load a .qpc back into (N, 4) float32 [x,y,z,intensity]."""
    import zlib

    with open(path, "rb") as f:
        if f.read(len(QPC_MAGIC)) != QPC_MAGIC:
            raise ValueError(f"{path} is not a .qpc file")
        count = int(np.frombuffer(f.read(4), dtype=np.uint32)[0])
        bounds = np.frombuffer(f.read(48), dtype=np.float64)
        raw = np.frombuffer(zlib.decompress(f.read()), dtype=np.uint8).reshape(count, 7)
    lo, hi = bounds[:3], bounds[3:]
    q = raw[:, :6].copy().view(np.uint16).reshape(count, 3).astype(np.float64)
    out = np.empty((count, 4), dtype=np.float32)
    out[:, :3] = (q / 65535.0 * (hi - lo) + lo).astype(np.float32)
    out[:, 3] = raw[:, 6].astype(np.float32) / 255.0
    return out
