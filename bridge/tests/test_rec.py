"""Recorder/.rec roundtrip and LaserScan converter tests."""

from types import SimpleNamespace

import numpy as np

from robot_bridge import protocol
from robot_bridge.server import Recorder, read_rec
from robot_bridge.ros2.converters import laserscan_to_xyzi


def test_rec_roundtrip(tmp_path):
    rec = Recorder()
    path = rec.start(str(tmp_path / "t.rec"))
    f1 = protocol.make_frame("pose", {"p": [1, 2, 3]}, seq=1, ts=10.0)
    f2 = protocol.make_frame("scan", b"\x00" * 16, seq=2, ts=10.1)
    rec.write("pose", f1)
    rec.write("scan", f2)
    rec.stop()
    records = list(read_rec(path))
    assert [(t, fr) for _, t, fr in records] == [("pose", f1), ("scan", f2)]
    assert records[0][0] > 0  # wall-clock stamps present


def test_rec_start_default_path(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    rec = Recorder()
    path = rec.start()
    assert path.startswith("recordings/")
    rec.stop()


def make_laserscan(ranges, intensities=(), range_min=0.1, range_max=10.0):
    import math
    return SimpleNamespace(
        ranges=list(ranges), intensities=list(intensities),
        angle_min=0.0, angle_increment=math.pi / 2,
        range_min=range_min, range_max=range_max)


def test_laserscan_basic():
    out = laserscan_to_xyzi(make_laserscan([1.0, 2.0]))
    np.testing.assert_allclose(out[0, :3], [1.0, 0.0, 0.0], atol=1e-6)
    np.testing.assert_allclose(out[1, :3], [0.0, 2.0, 0.0], atol=1e-6)
    assert np.all(out[:, 3] == 0.5)  # default intensity


def test_laserscan_drops_invalid():
    out = laserscan_to_xyzi(make_laserscan([1.0, float("inf"), 0.01, 20.0]))
    assert len(out) == 1  # inf, below range_min, above range_max all dropped


def test_laserscan_normalizes_intensities():
    out = laserscan_to_xyzi(make_laserscan([1.0, 1.0], intensities=[10.0, 47.0]))
    np.testing.assert_allclose(out[:, 3], [10 / 47, 1.0], atol=1e-5)
