"""Converter tests using hand-built fake PointCloud2/Odometry objects — no ROS imports."""

from types import SimpleNamespace

import numpy as np
import pytest

from robot_bridge.ros2.converters import (
    FLOAT32,
    occupancygrid_to_grid,
    odometry_to_pose,
    pointcloud2_to_xyzi,
    stamp_to_seconds,
)


def make_field(name: str, offset: int, datatype: int = FLOAT32):
    return SimpleNamespace(name=name, offset=offset, datatype=datatype)


def make_cloud(points: np.ndarray, point_step: int = 16, extra_fields=()) -> SimpleNamespace:
    """Build a fake PointCloud2 with x,y,z,intensity float32 fields at offsets 0,4,8,12."""
    n = len(points)
    data = np.zeros((n, point_step), dtype=np.uint8)
    data[:, :16] = points.astype(np.float32).view(np.uint8).reshape(n, 16)
    return SimpleNamespace(
        fields=[make_field("x", 0), make_field("y", 4), make_field("z", 8),
                make_field("intensity", 12), *extra_fields],
        width=n, height=1, point_step=point_step,
        data=data.tobytes(),
    )


def test_pointcloud2_roundtrip():
    pts = np.array([[1.0, 2.0, 3.0, 0.5], [-1.0, -2.0, -3.0, 1.0]], dtype=np.float32)
    out = pointcloud2_to_xyzi(make_cloud(pts))
    np.testing.assert_array_equal(out, pts)
    assert out.dtype == np.float32
    assert out.flags.c_contiguous


def test_pointcloud2_with_padding_stride():
    # 32-byte point_step (e.g. extra ring/time fields after the first 16 bytes)
    pts = np.array([[5.0, 6.0, 7.0, 0.25]], dtype=np.float32)
    out = pointcloud2_to_xyzi(make_cloud(pts, point_step=32))
    np.testing.assert_array_equal(out, pts)


def test_pointcloud2_decimate():
    pts = np.arange(40, dtype=np.float32).reshape(10, 4)
    out = pointcloud2_to_xyzi(make_cloud(pts), decimate=3)
    np.testing.assert_array_equal(out, pts[::3])


def test_pointcloud2_drops_nonfinite():
    pts = np.array([[1.0, 2.0, 3.0, 0.5],
                    [np.nan, 0.0, 0.0, 0.1],
                    [4.0, 5.0, 6.0, 0.9]], dtype=np.float32)
    out = pointcloud2_to_xyzi(make_cloud(pts))
    np.testing.assert_array_equal(out, pts[[0, 2]])


def test_pointcloud2_intensity_scale():
    # raw Livox reflectivity 0..255 -> wire 0..1, clipped
    pts = np.array([[1.0, 2.0, 3.0, 0.0],
                    [4.0, 5.0, 6.0, 127.5],
                    [7.0, 8.0, 9.0, 300.0]], dtype=np.float32)
    out = pointcloud2_to_xyzi(make_cloud(pts), intensity_scale=1.0 / 255.0)
    np.testing.assert_allclose(out[:, 3], [0.0, 0.5, 1.0], atol=1e-6)
    np.testing.assert_array_equal(out[:, :3], pts[:, :3])


def test_pointcloud2_missing_field():
    cloud = make_cloud(np.zeros((1, 4), dtype=np.float32))
    cloud.fields = cloud.fields[:3]  # drop intensity
    with pytest.raises(ValueError, match="intensity"):
        pointcloud2_to_xyzi(cloud)


def test_transform_xyzi_rotation_translation():
    from robot_bridge.ros2.converters import transform_xyzi
    import math
    # 90 deg yaw about z + translate (1, 2, 3): (1,0,0) -> (0,1,0) -> (1,3,3)
    s45 = math.sin(math.pi / 4)
    pts = np.array([[1.0, 0.0, 0.0, 0.7],
                    [0.0, 1.0, 0.0, 0.2]], dtype=np.float32)
    out = transform_xyzi(pts, (1.0, 2.0, 3.0), (0.0, 0.0, s45, s45))
    np.testing.assert_allclose(out[0, :3], [1.0, 3.0, 3.0], atol=1e-6)
    np.testing.assert_allclose(out[1, :3], [0.0, 2.0, 3.0], atol=1e-6)
    np.testing.assert_array_equal(out[:, 3], pts[:, 3])  # intensity untouched
    assert out.dtype == np.float32


def test_transform_xyzi_identity():
    from robot_bridge.ros2.converters import transform_xyzi
    pts = np.arange(8, dtype=np.float32).reshape(2, 4)
    out = transform_xyzi(pts, (0.0, 0.0, 0.0), (0.0, 0.0, 0.0, 1.0))
    np.testing.assert_allclose(out, pts, atol=1e-7)


def test_odometry_to_pose():
    msg = SimpleNamespace(pose=SimpleNamespace(pose=SimpleNamespace(
        position=SimpleNamespace(x=1.0, y=2.0, z=0.3),
        orientation=SimpleNamespace(x=0.0, y=0.0, z=0.7071, w=0.7071),
    )))
    p, q = odometry_to_pose(msg)
    assert p == (1.0, 2.0, 0.3)
    assert q == (0.0, 0.0, 0.7071, 0.7071)


def test_occupancygrid_to_grid():
    # 90 deg yaw quaternion: z = sin(45deg), w = cos(45deg)
    import math
    s45 = math.sin(math.pi / 4)
    msg = SimpleNamespace(
        info=SimpleNamespace(
            width=3, height=2, resolution=0.05,
            origin=SimpleNamespace(
                position=SimpleNamespace(x=-1.5, y=-2.0, z=0.0),
                orientation=SimpleNamespace(x=0.0, y=0.0, z=s45, w=s45))),
        data=[0, 100, -1, 50, 50, -1],
    )
    grid = occupancygrid_to_grid(msg)
    assert (grid["width"], grid["height"], grid["resolution"]) == (3, 2, 0.05)
    assert grid["origin"][0] == -1.5 and grid["origin"][1] == -2.0
    assert grid["origin"][2] == pytest.approx(math.pi / 2)
    assert grid["cells"].dtype == np.int8
    np.testing.assert_array_equal(grid["cells"].view(np.uint8), [0, 100, 255, 50, 50, 255])


def test_stamp_to_seconds():
    assert stamp_to_seconds(SimpleNamespace(sec=100, nanosec=250_000_000)) == 100.25


def test_ros2_package_imports_without_rclpy():
    """The ros2 subpackage must import cleanly on machines without ROS2."""
    import robot_bridge.ros2
    import robot_bridge.ros2.__main__  # noqa: F401 — lazy rclpy import inside main
