"""ROS2 message -> wire payload converters.

Deliberately free of ROS imports: functions take duck-typed message objects
(anything with the right attributes), so they are unit-testable on machines
without ROS2. On the Jetson the real sensor_msgs/nav_msgs objects are passed in.
"""

from __future__ import annotations

import numpy as np

# sensor_msgs/msg/PointField datatype constants (REP-117)
FLOAT32 = 7


def pointcloud2_to_xyzi(msg, *, decimate: int = 1) -> np.ndarray:
    """Convert a sensor_msgs/msg/PointCloud2 to a float32 (N, 4) [x,y,z,intensity] array.

    Requires x, y, z, intensity fields, each FLOAT32 (FAST-LIO2's
    /cloud_registered_body satisfies this). `decimate` keeps every k-th point.
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
    return np.ascontiguousarray(out)


def odometry_to_pose(msg) -> tuple[tuple[float, float, float],
                                   tuple[float, float, float, float]]:
    """Convert a nav_msgs/msg/Odometry to (position, quaternion) tuples."""
    p = msg.pose.pose.position
    q = msg.pose.pose.orientation
    return (p.x, p.y, p.z), (q.x, q.y, q.z, q.w)


def stamp_to_seconds(stamp) -> float:
    """builtin_interfaces/msg/Time -> float seconds."""
    return stamp.sec + stamp.nanosec * 1e-9
