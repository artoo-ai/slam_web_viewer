"""Roundtrip and byte-layout tests for the wire protocol (docs/protocol.md)."""

import struct

import numpy as np
import pytest

from robot_bridge import protocol


def test_frame_roundtrip_map_payload():
    payload = protocol.pose_payload((1.0, 2.0, 3.0), (0.0, 0.0, 0.0, 1.0))
    raw = protocol.make_frame(protocol.CH_POSE, payload, seq=5, ts=1718000000.125)
    frame = protocol.parse_frame(raw)
    assert frame == {
        "topic": "pose",
        "ts": 1718000000.125,
        "seq": 5,
        "data": {"p": [1.0, 2.0, 3.0], "q": [0.0, 0.0, 0.0, 1.0], "frame": "map"},
    }


def test_frame_roundtrip_bin_payload():
    xyzi = np.array([[1.5, -2.5, 0.25, 0.8]], dtype=np.float32)
    raw = protocol.make_frame(protocol.CH_SCAN, protocol.pack_scan(xyzi), seq=0, ts=1.0)
    frame = protocol.parse_frame(raw)
    assert frame["topic"] == "scan"
    assert isinstance(frame["data"], bytes)  # msgpack bin, not str
    out = protocol.unpack_scan(frame["data"])
    np.testing.assert_array_equal(out, xyzi)


def test_pack_scan_byte_layout_little_endian():
    xyzi = np.array([[1.0, 2.0, 3.0, 0.5], [-1.0, -2.0, -3.0, 1.0]], dtype=np.float32)
    data = protocol.pack_scan(xyzi)
    assert len(data) == 2 * protocol.SCAN_STRIDE_BYTES
    # explicit little-endian struct unpack, independent of numpy
    assert struct.unpack("<8f", data) == (1.0, 2.0, 3.0, 0.5, -1.0, -2.0, -3.0, 1.0)


def test_pack_scan_rejects_bad_input():
    with pytest.raises(ValueError):
        protocol.pack_scan(np.zeros((3, 4), dtype=np.float64))
    with pytest.raises(ValueError):
        protocol.pack_scan(np.zeros((3, 3), dtype=np.float32))


def test_pack_scan_handles_non_contiguous():
    big = np.arange(32, dtype=np.float32).reshape(4, 8)
    view = big[:, :4]  # non-contiguous slice
    assert not view.flags.c_contiguous
    out = protocol.unpack_scan(protocol.pack_scan(view))
    np.testing.assert_array_equal(out, view)


def test_unpack_scan_rejects_bad_length():
    with pytest.raises(ValueError):
        protocol.unpack_scan(b"\x00" * 15)


def test_seq_wraps_at_2_32():
    raw = protocol.make_frame(protocol.CH_POSE, {}, seq=2**32 + 7, ts=0.0)
    assert protocol.parse_frame(raw)["seq"] == 7


def test_command_roundtrip():
    import msgpack
    raw = msgpack.packb({"cmd": "set_param", "id": 8, "node": "slam",
                         "params": {"voxel_size": 0.1}}, use_bin_type=True)
    cmd = protocol.parse_command(raw)
    assert cmd["cmd"] == "set_param"
    assert cmd["params"]["voxel_size"] == 0.1


def test_parse_command_rejects_non_command():
    import msgpack
    with pytest.raises(ValueError):
        protocol.parse_command(msgpack.packb([1, 2, 3]))


def test_status_payload_omits_optional_keys():
    assert protocol.status_payload("loop_closure") == {"event": "loop_closure"}
    assert protocol.status_payload("object_detected", label="person", count=2) == {
        "event": "object_detected", "label": "person", "count": 2,
    }
