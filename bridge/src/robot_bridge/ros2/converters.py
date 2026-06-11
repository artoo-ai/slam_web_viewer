"""ROS2 message -> wire payload converters.

Deliberately free of ROS imports: functions take duck-typed message objects
(anything with the right attributes), so they are unit-testable on machines
without ROS2. On the Jetson the real sensor_msgs/nav_msgs objects are passed in.
"""

from __future__ import annotations

import numpy as np

# sensor_msgs/msg/PointField datatype constants (REP-117)
FLOAT32 = 7


def pointcloud2_to_xyzi(msg, *, decimate: int = 1,
                        intensity_scale: float = 1.0) -> np.ndarray:
    """Convert a sensor_msgs/msg/PointCloud2 to a float32 (N, 4) [x,y,z,intensity] array.

    Requires x, y, z, intensity fields, each FLOAT32 (FAST-LIO2's
    /cloud_registered_body satisfies this). `decimate` keeps every k-th point.
    `intensity_scale` maps raw intensity to the wire's 0..1 range (clipped) —
    use 1/255 for Livox reflectivity.
    """
    fields = {f.name: f for f in msg.fields}
    for name in ("x", "y", "z", "intensity"):
        if name not in fields:
            raise ValueError(f"PointCloud2 missing field {name!r}")
        if fields[name].datatype != FLOAT32:
            raise ValueError(f"field {name!r} is not FLOAT32")

    n_points = msg.width * msg.height
    raw = np.frombuffer(bytes(msg.data), dtype=np.uint8).reshape(n_points, msg.point_step)

    out = np.empty((n_points, 4), dtype=np.float32)
    for i, name in enumerate(("x", "y", "z", "intensity")):
        offset = fields[name].offset
        out[:, i] = raw[:, offset:offset + 4].copy().view(np.float32)[:, 0]

    if decimate > 1:
        out = out[::decimate]
    # drop non-finite points (FAST-LIO2 occasionally emits NaNs)
    out = out[np.isfinite(out).all(axis=1)]
    if intensity_scale != 1.0:
        np.clip(out[:, 3] * intensity_scale, 0.0, 1.0, out=out[:, 3])
    return np.ascontiguousarray(out)


def transform_xyzi(xyzi: np.ndarray,
                   translation: tuple[float, float, float],
                   quaternion: tuple[float, float, float, float]) -> np.ndarray:
    """Rigid-transform the xyz columns of an (N, 4) [x,y,z,intensity] array.

    `quaternion` is [x, y, z, w]. Intensity passes through. Pure numpy so it is
    unit-testable without ROS; the bridge feeds it TF lookups.
    """
    qx, qy, qz, qw = quaternion
    # quaternion -> rotation matrix
    rot = np.array([
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
        [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
        [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ], dtype=np.float64)
    out = xyzi.copy()
    out[:, :3] = (xyzi[:, :3] @ rot.T.astype(np.float32)) + \
        np.asarray(translation, dtype=np.float32)
    return out


def occupancygrid_to_grid(msg) -> dict:
    """Convert a nav_msgs/msg/OccupancyGrid to the wire payload's components.

    Returns kwargs for protocol.occupancy_grid_payload: width, height,
    resolution, origin (x, y, theta from the origin quaternion's yaw), cells.
    """
    import math

    info = msg.info
    q = info.origin.orientation
    theta = math.atan2(2.0 * (q.w * q.z + q.x * q.y),
                       1.0 - 2.0 * (q.y * q.y + q.z * q.z))
    cells = np.asarray(msg.data, dtype=np.int8)
    return {
        "width": int(info.width),
        "height": int(info.height),
        "resolution": float(info.resolution),
        "origin": (float(info.origin.position.x), float(info.origin.position.y), theta),
        "cells": cells,
    }


def odometry_to_pose(msg) -> tuple[tuple[float, float, float],
                                   tuple[float, float, float, float]]:
    """Convert a nav_msgs/msg/Odometry to (position, quaternion) tuples."""
    p = msg.pose.pose.position
    q = msg.pose.pose.orientation
    return (p.x, p.y, p.z), (q.x, q.y, q.z, q.w)


def stamp_to_seconds(stamp) -> float:
    """builtin_interfaces/msg/Time -> float seconds."""
    return stamp.sec + stamp.nanosec * 1e-9
