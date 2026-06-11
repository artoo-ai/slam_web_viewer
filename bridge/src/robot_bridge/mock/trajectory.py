"""Parametric robot trajectory: a rounded-rectangle loop inside the room.

Arc-length parameterized so speed is constant. Yaw follows the path tangent;
a slight sinusoidal pitch/roll makes the pose glyph look alive.
"""

from __future__ import annotations

import math

import numpy as np

# rounded rectangle: straight segments + quarter-circle corners
HALF_X = 2.8   # rectangle half-extents of the straight section centers
HALF_Y = 1.8
RADIUS = 0.8   # corner radius
Z_HEIGHT = 0.35  # sensor height above floor


def _segments():
    """(length, kind, params) pieces of the loop, counter-clockwise from (+x edge, -y)."""
    sx, sy, r = HALF_X, HALF_Y, RADIUS
    straight_x = 2 * sx  # along x edges
    straight_y = 2 * sy  # along y edges
    arc = math.pi / 2 * r
    return [
        # bottom edge: left→right, heading +x
        (straight_x, "line", (np.array([-sx, -sy - r]), np.array([1.0, 0.0]))),
        # bottom-right corner
        (arc, "arc", (np.array([sx, -sy]), -math.pi / 2)),
        # right edge: bottom→top, heading +y
        (straight_y, "line", (np.array([sx + r, -sy]), np.array([0.0, 1.0]))),
        (arc, "arc", (np.array([sx, sy]), 0.0)),
        # top edge: right→left, heading -x
        (straight_x, "line", (np.array([sx, sy + r]), np.array([-1.0, 0.0]))),
        (arc, "arc", (np.array([-sx, sy]), math.pi / 2)),
        # left edge: top→bottom, heading -y
        (straight_y, "line", (np.array([-sx - r, sy]), np.array([0.0, -1.0]))),
        (arc, "arc", (np.array([-sx, -sy]), math.pi)),
    ]


SEGMENTS = _segments()
LOOP_LENGTH = sum(s[0] for s in SEGMENTS)


def pose_at(distance: float) -> tuple[np.ndarray, np.ndarray, int]:
    """Pose at arc-length `distance` along the loop.

    Returns (position (3,), quaternion [x,y,z,w] (4,), lap_count).
    """
    laps, s = divmod(distance, LOOP_LENGTH)
    for length, kind, params in SEGMENTS:
        if s > length:
            s -= length
            continue
        if kind == "line":
            start, direction = params
            xy = start + direction * s
            yaw = math.atan2(direction[1], direction[0])
        else:
            center, start_angle = params
            # CCW arc from start_angle, radius vector sweeps s/RADIUS radians
            ang = start_angle + s / RADIUS
            xy = center + RADIUS * np.array([math.cos(ang), math.sin(ang)])
            yaw = ang + math.pi / 2  # tangent of CCW circle
        break
    else:  # pragma: no cover — divmod guarantees s <= LOOP_LENGTH
        raise AssertionError("arc-length out of range")

    # gentle body motion
    pitch = 0.03 * math.sin(distance * 2.1)
    roll = 0.02 * math.sin(distance * 1.7)
    q = _quat_from_euler(roll, pitch, yaw)
    pos = np.array([xy[0], xy[1], Z_HEIGHT + 0.01 * math.sin(distance * 3.3)])
    return pos, q, int(laps)


def _quat_from_euler(roll: float, pitch: float, yaw: float) -> np.ndarray:
    """ZYX (yaw-pitch-roll) euler to [x,y,z,w] quaternion."""
    cy, sy = math.cos(yaw / 2), math.sin(yaw / 2)
    cp, sp = math.cos(pitch / 2), math.sin(pitch / 2)
    cr, sr = math.cos(roll / 2), math.sin(roll / 2)
    return np.array([
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
        cr * cp * cy + sr * sp * sy,
    ])
