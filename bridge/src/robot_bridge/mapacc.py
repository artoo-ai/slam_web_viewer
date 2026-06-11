"""Voxel-deduplicating map accumulator shared by the mock and rclpy bridges.

Feed it map-frame scans; it returns only the points that landed in voxels never
seen before — the `map` channel's incremental delta. Memory is one int64 set
entry per occupied voxel (~50 MB at 100M voxels; a room is thousands).
"""

from __future__ import annotations

import numpy as np


class MapAccumulator:
    def __init__(self, voxel_size: float = 0.10, max_voxels: int = 5_000_000):
        self.voxel_size = voxel_size
        self.max_voxels = max_voxels
        self._seen: set[int] = set()
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
        return delta
