"""Mock occupancy grid: rasterize the world once, reveal it progressively around
the robot's path — simulates what slam_toolbox produces during frontier exploration.
"""

from __future__ import annotations

import numpy as np

from .world import CEILING, ROOM_X, ROOM_Y, Box, Cylinder, Plane

RESOLUTION = 0.05  # m/cell, matches slam_toolbox default
REVEAL_RADIUS = 3.0  # m — cells within this range of the robot become known

FREE = 0
OCCUPIED = 100
UNKNOWN = -1


class ExplorationGrid:
    """Static rasterized world + a growing visited mask."""

    def __init__(self, planes: list[Plane], boxes: list[Box], cylinders: list[Cylinder]):
        hx, hy = ROOM_X / 2, ROOM_Y / 2
        # grid covers the room plus the corridor stub (x to hx+3) with margin
        self.origin = (-hx - 0.5, -hy - 0.5, 0.0)
        self.width = int((ROOM_X + 3.0 + 1.0) / RESOLUTION)
        self.height = int((ROOM_Y + 1.0) / RESOLUTION)

        self.static = np.full((self.height, self.width), UNKNOWN, dtype=np.int8)
        self.visited = np.zeros((self.height, self.width), dtype=bool)

        # cell-center coordinates
        xs = self.origin[0] + (np.arange(self.width) + 0.5) * RESOLUTION
        ys = self.origin[1] + (np.arange(self.height) + 0.5) * RESOLUTION
        self.xs, self.ys = xs, ys
        gx, gy = np.meshgrid(xs, ys)

        # free space: room interior + corridor interior
        room = (np.abs(gx) < hx) & (np.abs(gy) < hy)
        corridor = (gx >= hx) & (gx < hx + 3.0) & (np.abs(gy) < 1.0)
        self.static[room | corridor] = FREE

        # walls: vertical planes rasterized as occupied cell bands
        for plane in planes:
            if plane.axis == 2:  # floor/ceiling don't appear in a 2D grid
                continue
            if plane.axis == 0:
                band = np.abs(gx - plane.offset) <= RESOLUTION
                within = (gy >= plane.bounds_lo[1]) & (gy <= plane.bounds_hi[1])
            else:
                band = np.abs(gy - plane.offset) <= RESOLUTION
                within = (gx >= plane.bounds_lo[0]) & (gx <= plane.bounds_hi[0])
            self.static[band & within] = OCCUPIED

        # obstacles
        for box in boxes:
            if box.lo[2] < 0.5:  # only obstacles a 2D scan plane would see
                inside = (gx >= box.lo[0]) & (gx <= box.hi[0]) & \
                         (gy >= box.lo[1]) & (gy <= box.hi[1])
                self.static[inside] = OCCUPIED
        for cyl in cylinders:
            inside = (gx - cyl.center[0]) ** 2 + (gy - cyl.center[1]) ** 2 <= cyl.radius ** 2
            self.static[inside] = OCCUPIED

        assert CEILING > 0  # silence unused-import linters; ceiling irrelevant in 2D

    def reveal(self, x: float, y: float) -> None:
        """Mark cells within REVEAL_RADIUS of (x, y) as visited."""
        dist2 = (self.xs[None, :] - x) ** 2 + (self.ys[:, None] - y) ** 2
        self.visited |= dist2 <= REVEAL_RADIUS**2

    def snapshot(self) -> np.ndarray:
        """Flat row-major int8 cells: static value where visited, unknown elsewhere."""
        out = np.where(self.visited, self.static, UNKNOWN).astype(np.int8)
        return out.ravel()

    def costmap(self, inflation_radius_m: float = 0.30) -> np.ndarray:
        """Nav2-style cost from the revealed grid: 100 lethal at obstacles, a
        distance-based gradient inside the inflation radius, 0 free, -1 unknown.
        Pure numpy (Chebyshev-ish via iterative dilation) — close enough to see
        where passages pinch shut."""
        snap = np.where(self.visited, self.static, UNKNOWN).astype(np.int8)
        lethal = snap == OCCUPIED
        steps = max(1, int(round(inflation_radius_m / RESOLUTION)))
        cost = np.where(lethal, 100, np.where(snap == UNKNOWN, UNKNOWN, 0)).astype(np.int8)
        ring = lethal.copy()
        for i in range(1, steps + 1):
            grown = np.zeros_like(ring)
            grown[1:, :] |= ring[:-1, :]
            grown[:-1, :] |= ring[1:, :]
            grown[:, 1:] |= ring[:, :-1]
            grown[:, :-1] |= ring[:, 1:]
            grown |= ring
            band = grown & ~ring & (snap == FREE)
            # 99 inscribed next to lethal, decaying outward
            cost[band] = max(1, int(99 * (1.0 - i / (steps + 1))))
            ring = grown
        return cost.ravel()
