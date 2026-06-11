"""Replay a .rec capture over WebSocket at configurable speed.

    python -m robot_bridge.replay recordings/session_X.rec [--port 9090]
        [--speed 2.0] [--loop]

The viewer connects exactly as it would to a live bridge. Frames keep their
original seq/ts; pacing follows recorded wall-clock deltas divided by --speed.
"""

from __future__ import annotations

import argparse
import asyncio
import logging

from . import protocol
from .server import BridgeServer, Client, read_rec

log = logging.getLogger("robot_bridge.replay")


class ReplayBridge:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.server = BridgeServer(
            server_name="replay", channels=["replay"], app_version="0.1.0",
            command_handler=self.on_command)

    async def on_command(self, cmd: dict, client: Client) -> None:
        if cmd.get("cmd") == "ping":
            await self.server.reply_ack(
                client, protocol.pong_payload(cmd.get("id", 0), cmd.get("t", 0.0)))

    async def stream(self) -> None:
        while True:
            last_ts = None
            count = 0
            for ts, topic, frame in read_rec(self.args.file):
                if last_ts is not None:
                    delay = max(0.0, (ts - last_ts) / self.args.speed)
                    await asyncio.sleep(min(delay, 5.0))
                last_ts = ts
                self.server.broadcast_encoded(topic, frame)
                count += 1
            log.info("replayed %d frames", count)
            if not self.args.loop:
                log.info("replay finished — serving idle (Ctrl-C to exit)")
                await asyncio.Future()
            log.info("looping")

    async def run(self) -> None:
        await asyncio.gather(
            self.server.serve_forever(self.args.host, self.args.port),
            self.stream())


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay a .rec capture")
    parser.add_argument("file")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")
    try:
        asyncio.run(ReplayBridge(args).run())
    except KeyboardInterrupt:
        log.info("bye")


if __name__ == "__main__":
    main()
