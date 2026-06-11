import numpy as np

from robot_bridge.mapacc import MapAccumulator, load_qpc


def test_qpc_roundtrip_accuracy(tmp_path):
    rng = np.random.default_rng(7)
    pts = np.empty((20_000, 4), dtype=np.float32)
    pts[:, 0] = rng.uniform(-6, 9, 20_000)
    pts[:, 1] = rng.uniform(-5, 5, 20_000)
    pts[:, 2] = rng.uniform(0, 2.6, 20_000)
    pts[:, 3] = rng.uniform(0, 1, 20_000)
    acc = MapAccumulator(voxel_size=0.01)
    acc.add_scan(pts)
    kept = acc.points()

    info = acc.save_qpc(str(tmp_path / "m.qpc"))
    out = load_qpc(info["path"])
    assert len(out) == len(kept) == info["points"]
    # quantization error bounded by extent/65535 (~0.23 mm here)
    err = np.abs(out[:, :3] - kept[:, :3]).max()
    assert err < 0.001
    assert np.abs(out[:, 3] - kept[:, 3]).max() < 1 / 254
    # compressed file is much smaller than raw float32
    assert info["bytes"] < len(kept) * 16 * 0.5


def test_qpc_empty_raises(tmp_path):
    import pytest
    acc = MapAccumulator()
    with pytest.raises(ValueError):
        acc.save_qpc(str(tmp_path / "e.qpc"))
