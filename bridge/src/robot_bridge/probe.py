"""Connection probe: connect to a bridge, print the hello, then report per-topic
frame counts/rates for a few seconds. Use to isolate network vs bridge vs viewer.

    python -m robot_bridge.probe ws://gizmo.local:9090
    python -m robot_bridge.probe ws://10.20.30.40:9090 --seconds 10
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from collections import Counter, defaultdict

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidURI, WebSocketException

from . import protocol


async def probe(url: str, seconds: float) -> int:
    print(f"probe: connecting to {url} ...")
    try:
        ws = await asyncio.wait_for(connect(url, max_size=None), timeout=5.0)
    except asyncio.TimeoutError:
        print("probe: FAIL — connection timed out (host unreachable, wrong port, or firewall)")
        return 1
    except (OSError, InvalidURI, WebSocketException) as e:
        print(f"probe: FAIL — {type(e).__name__}: {e}")
        print("probe: hint — if this is a DNS error, try the robot's IP, or "
              "'hostname' vs 'hostname.local'")
        return 1

    async with ws:
        print("probe: connected, listening...")
        counts: Counter[str] = Counter()
        bytes_per: defaultdict[str, int] = defaultdict(int)
        hello_seen = False
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.monotonic()))
            except asyncio.TimeoutError:
                break
            try:
                frame = protocol.parse_frame(raw)
            except ValueError:
                print("probe: WARNING — received a non-protocol frame")
                continue
            topic = frame["topic"]
            counts[topic] += 1
            bytes_per[topic] += len(raw)
            if topic == protocol.CH_HELLO and not hello_seen:
                hello_seen = True
                d = frame["data"]
                print(f"probe: hello — server={d.get('server')} protocol={d.get('protocol')} "
                      f"channels={d.get('channels')}")

        if not hello_seen:
            print("probe: FAIL — connected but no hello frame (is this really the viewer bridge?)")
            return 1
        print(f"\nprobe: traffic over {seconds:.0f}s:")
        if len(counts) == 1:
            print("probe: WARNING — only hello received. The bridge is up but publishing "
                  "nothing: check that the SLAM stack is running and the bridge --stack "
                  "mode matches it (2d vs 3d).")
        for topic in sorted(counts):
            rate = counts[topic] / seconds
            kib = bytes_per[topic] / 1024
            print(f"  {topic:16s} {counts[topic]:5d} frames  {rate:6.1f} Hz  {kib:9.1f} KiB")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Bridge connection probe")
    parser.add_argument("url", help="e.g. ws://gizmo.local:9090")
    parser.add_argument("--seconds", type=float, default=5.0)
    args = parser.parse_args()
    sys.exit(asyncio.run(probe(args.url, args.seconds)))


if __name__ == "__main__":
    main()
