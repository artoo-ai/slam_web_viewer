"""Assert committed golden fixtures decode to expected.json (cross-language contract)."""

import json
from pathlib import Path

import numpy as np
import pytest

from robot_bridge import protocol

FIXTURES = Path(__file__).parent / "fixtures"
EXPECTED = json.loads((FIXTURES / "expected.json").read_text())

FRAME_FIXTURES = [n for n, e in EXPECTED.items() if "topic" in e]


@pytest.mark.parametrize("name", FRAME_FIXTURES)
def test_fixture_decodes_to_expected(name):
    frame = protocol.parse_frame((FIXTURES / name).read_bytes())
    exp = EXPECTED[name]
    assert frame["topic"] == exp["topic"]
    assert frame["ts"] == exp["ts"]
    assert frame["seq"] == exp["seq"]
    if "points" in exp:
        pts = protocol.unpack_scan(frame["data"])
        np.testing.assert_array_equal(pts, np.array(exp["points"], dtype=np.float32))
    elif "path" in exp:
        p = exp["path"]
        assert frame["data"]["frame"] == p["frame"]
        poses = np.frombuffer(frame["data"]["poses"], dtype=np.float32).reshape(-1, 3)
        np.testing.assert_array_equal(poses, np.array(p["poses"], dtype=np.float32))
    elif "grid" in exp:
        g, d = exp["grid"], frame["data"]
        assert (d["width"], d["height"], d["resolution"], d["origin"], d["encoding"]) == \
               (g["width"], g["height"], g["resolution"], g["origin"], "rle")
        cells = protocol.unpack_grid_rle(d["data"], g["width"] * g["height"])
        np.testing.assert_array_equal(cells, g["cells"])
    else:
        assert frame["data"] == exp["data"]


COMMAND_FIXTURES = [n for n, e in EXPECTED.items() if "command" in e]


@pytest.mark.parametrize("name", COMMAND_FIXTURES)
def test_command_fixture_parses(name):
    cmd = protocol.parse_command((FIXTURES / name).read_bytes())
    assert cmd == EXPECTED[name]["command"]
