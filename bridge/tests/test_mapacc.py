import numpy as np

from robot_bridge.mapacc import MapAccumulator


def test_first_scan_all_new():
    acc = MapAccumulator(voxel_size=0.1)
    pts = np.array([[0.0, 0.0, 0.0, 0.5], [1.0, 1.0, 1.0, 0.6]], dtype=np.float32)
    delta = acc.add_scan(pts)
    assert delta is not None and len(delta) == 2
    assert acc.total_points == 2


def test_repeat_scan_yields_nothing():
    acc = MapAccumulator(voxel_size=0.1)
    pts = np.array([[0.0, 0.0, 0.0, 0.5]], dtype=np.float32)
    assert acc.add_scan(pts) is not None
    assert acc.add_scan(pts) is None


def test_same_voxel_deduped_within_scan():
    acc = MapAccumulator(voxel_size=0.1)
    pts = np.array([[0.01, 0.01, 0.01, 0.5],
                    [0.02, 0.02, 0.02, 0.9],   # same 10 cm voxel
                    [0.5, 0.5, 0.5, 0.1]], dtype=np.float32)
    delta = acc.add_scan(pts)
    assert delta is not None and len(delta) == 2


def test_negative_coords():
    acc = MapAccumulator(voxel_size=0.1)
    pts = np.array([[-5.0, -3.0, 0.2, 0.5], [5.0, 3.0, 0.2, 0.5]], dtype=np.float32)
    delta = acc.add_scan(pts)
    assert delta is not None and len(delta) == 2
    assert acc.add_scan(pts) is None
