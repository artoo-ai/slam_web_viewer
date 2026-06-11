"""Synthetic world geometry for the mock LiDAR: planes, AABBs, cylinders.

A 10 m x 8 m room (origin at room center, floor at z=0, ceiling at 2.5 m) with a
corridor stub, two box obstacles, and two pillars. Each surface carries a base
intensity so the viewer's colormap shows structure.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

ROOM_X = 10.0  # extent along x: -5..+5
ROOM_Y = 8.0   # extent along y: -4..+4
CEILING = 2.5


@dataclass
class Plane:
    """Axis-aligned finite rectangle: points satisfy axis==offset within bounds."""
    axis: int            # 0=x, 1=y, 2=z (the fixed axis)
    offset: float
    bounds_lo: np.ndarray  # (3,) lo corner of the rectangle (fixed axis value ignored)
    bounds_hi: np.ndarray
    intensity: float


@dataclass
class Box:
    lo: np.ndarray  # (3,)
    hi: np.ndarray
    intensity: float


@dataclass
class Cylinder:
    center: np.ndarray  # (2,) x,y — vertical, from z=0 to height
    radius: float
    height: float
    intensity: float


def build_world() -> tuple[list[Plane], list[Box], list[Cylinder]]:
    hx, hy = ROOM_X / 2, ROOM_Y / 2
    planes = [
        # floor and ceiling
        Plane(2, 0.0, np.array([-hx, -hy, 0.0]), np.array([hx, hy, 0.0]), 0.30),
        Plane(2, CEILING, np.array([-hx, -hy, CEILING]), np.array([hx, hy, CEILING]), 0.20),
        # walls (x = ±hx, y = ±hy); +x wall has a 2 m gap (corridor mouth) at y in [-1, 1]
        Plane(0, -hx, np.array([-hx, -hy, 0.0]), np.array([-hx, hy, CEILING]), 0.55),
        Plane(0, hx, np.array([hx, -hy, 0.0]), np.array([hx, -1.0, CEILING]), 0.55),
        Plane(0, hx, np.array([hx, 1.0, 0.0]), np.array([hx, hy, CEILING]), 0.55),
        Plane(1, -hy, np.array([-hx, -hy, 0.0]), np.array([hx, -hy, CEILING]), 0.60),
        Plane(1, hy, np.array([-hx, hy, 0.0]), np.array([hx, hy, CEILING]), 0.60),
        # corridor stub: 2 m wide, 3 m deep, beyond the +x wall gap
        Plane(1, -1.0, np.array([hx, -1.0, 0.0]), np.array([hx + 3.0, -1.0, CEILING]), 0.50),
        Plane(1, 1.0, np.array([hx, 1.0, 0.0]), np.array([hx + 3.0, 1.0, CEILING]), 0.50),
        Plane(0, hx + 3.0, np.array([hx + 3.0, -1.0, 0.0]), np.array([hx + 3.0, 1.0, CEILING]), 0.55),
        Plane(2, 0.0, np.array([hx, -1.0, 0.0]), np.array([hx + 3.0, 1.0, 0.0]), 0.30),
        Plane(2, CEILING, np.array([hx, -1.0, CEILING]), np.array([hx + 3.0, 1.0, CEILING]), 0.20),
    ]
    boxes = [
        Box(np.array([-3.5, 1.5, 0.0]), np.array([-2.5, 2.5, 0.8]), 0.85),   # crate
        Box(np.array([2.0, -3.0, 0.0]), np.array([3.2, -2.2, 1.2]), 0.90),   # cabinet
    ]
    cylinders = [
        Cylinder(np.array([-1.5, -1.5]), 0.25, CEILING, 0.75),
        Cylinder(np.array([1.5, 1.8]), 0.25, CEILING, 0.75),
    ]
    return planes, boxes, cylinders
