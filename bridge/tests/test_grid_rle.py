"""RLE occupancy-grid encoding tests (docs/protocol.md)."""

import numpy as np
import pytest

from robot_bridge import protocol


def test_rle_roundtrip_simple():
    cells = np.array([0, 0, 0, 100, 100, -1, -1, -1, -1, 50], dtype=np.int8)
    data = protocol.pack_grid_rle(cells)
    # 4 runs -> 12 bytes
    assert len(data) == 12
    out = protocol.unpack_grid_rle(data, len(cells))
    np.testing.assert_array_equal(out, cells.view(np.uint8))
    assert out[5] == 255  # -1 stored as 255


def test_rle_long_run_splits_at_65535():
    cells = np.full(70_000, -1, dtype=np.int8)
    data = protocol.pack_grid_rle(cells)
    assert len(data) == 6  # two records: 65535 + 4465
    out = protocol.unpack_grid_rle(data, 70_000)
    assert np.all(out == 255)


def test_rle_alternating_worst_case():
    cells = np.tile(np.array([0, 100], dtype=np.int8), 50)
    out = protocol.unpack_grid_rle(protocol.pack_grid_rle(cells), len(cells))
    np.testing.assert_array_equal(out, cells.view(np.uint8))


def test_rle_rejects_wrong_cell_count():
    data = protocol.pack_grid_rle(np.zeros(10, dtype=np.int8))
    with pytest.raises(ValueError, match="expected 11"):
        protocol.unpack_grid_rle(data, 11)


def test_occupancy_grid_payload_shape():
    cells = np.full(12, -1, dtype=np.int8)
    payload = protocol.occupancy_grid_payload(
        width=4, height=3, resolution=0.05, origin=(-1.0, -2.0, 0.0), cells=cells)
    assert payload["encoding"] == "rle"
    assert isinstance(payload["data"], bytes)
    out = protocol.unpack_grid_rle(payload["data"], 12)
    assert np.all(out == 255)


def test_grid_frame_roundtrip():
    cells = np.array([0, 100, -1, 0], dtype=np.int8)
    payload = protocol.occupancy_grid_payload(
        width=2, height=2, resolution=0.1, origin=(0.5, 0.5, 0.0), cells=cells)
    frame = protocol.parse_frame(
        protocol.make_frame(protocol.CH_OCCUPANCY_GRID, payload, seq=1, ts=2.0))
    assert frame["data"]["width"] == 2
    out = protocol.unpack_grid_rle(frame["data"]["data"], 4)
    np.testing.assert_array_equal(out, [0, 100, 255, 0])
