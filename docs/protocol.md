# Wire Protocol — v1

Single source of truth for the robot↔browser protocol. Both implementations
(`bridge/src/robot_bridge/protocol.py` and `web/src/lib/transport/protocol.ts`) implement this
document; the golden fixtures in `bridge/tests/fixtures/` keep them honest.

## Transport

- One WebSocket connection, default `ws://<robot>:9090`. All messages are **binary** WebSocket
  frames containing exactly one MessagePack-encoded value.
- Camera video is NOT on the WebSocket — it is MJPEG over HTTP (`http://<robot>:8080/stream/rgb`).

## Conventions

- All binary numeric payloads are **little-endian**.
- Coordinates follow ROS REP-103: **x forward, y left, z up**, meters, radians. The viewer keeps
  z-up in the Three.js scene (`camera.up = [0,0,1]`); there is no axis swizzling anywhere.
- Quaternions are `[x, y, z, w]`.
- Receivers MUST ignore unknown topics, unknown commands, and unknown keys in any map. This is the
  forward-compatibility rule that lets channels be added without breaking older peers.
- `protocol` version (announced in `hello`) bumps only on breaking changes to the envelope or to an
  existing payload.

## Frame envelope (robot → browser)

Every message is a MessagePack map:

```jsonc
{
  "topic": "scan",        // str — channel name, demux key
  "ts": 1718000000.123,   // float64 — sender wall clock, seconds since epoch
  "seq": 42,              // uint — per-channel monotonic counter, wraps at 2^32 (drop detection)
  "data": ...             // payload — msgpack bin (bytes) or msgpack map, per channel
}
```

## Channels

### Implemented

| topic | rate | `data` |
|---|---|---|
| `hello` | once, on connect | map — see below |
| `scan` | 10 Hz | **bin** — packed float32 LE, stride 16 B: `[x, y, z, intensity] × N`. Map frame. Intensity normalized 0..1. `N = byteLength / 16`. |
| `pose` | 20 Hz | map `{ "p": [x,y,z], "q": [x,y,z,w], "frame": "map" }` (float64) |
| `stats` | 1 Hz | map `{ "keyframes": uint, "total_pts": uint, "distance_m": float, "duration_s": float, "scan_hz": float, "health": float 0..1, "clients": uint }` |
| `log` | event | map `{ "level": "debug"\|"info"\|"warn"\|"error", "message": str }` |
| `status` | event | map `{ "event": str, "label"?: str, "count"?: uint }` — e.g. `loop_closure`, `tracking_lost`. Feeds TTS later. |
| `cmd_ack` | reply | map — reply to a command, correlated by `id` (see Commands) |
| `occupancy_grid` | ~0.5 Hz / on change | map — see below |
| `nav_status` | event + ~2 Hz while navigating | map `{ "state": "accepted"\|"navigating"\|"succeeded"\|"aborted"\|"canceled"\|"rejected", "goal_id"?: str, "distance_m"?: float, "eta_s"?: float, "message"?: str }` |

`occupancy_grid` payload:

```jsonc
{
  "width": 260,            // cells
  "height": 160,           // cells
  "resolution": 0.05,      // meters per cell
  "origin": [x, y, theta], // map-frame pose of cell (0,0)'s corner (ROS convention)
  "encoding": "rle",
  "data": bin              // RLE-encoded cells, row-major from origin
}
```

Cell values match ROS `nav_msgs/OccupancyGrid`: `0..100` = occupancy probability,
`255` (int8 `-1` cast to uint8) = unknown.

RLE encoding: a sequence of 3-byte records `[uint8 value, uint16 LE run_length]`,
run_length 1..65535. The decoded cell count MUST equal `width * height`.

`hello` payload:

```jsonc
{
  "protocol": 1,                  // protocol version
  "server": "mock",               // "mock" | "ros2"
  "channels": ["scan", "pose"],   // channels this server will publish
  "app_version": "0.1.0"
}
```

### Reserved (documented now, implemented in later slices)

| topic | `data` (sketch) |
|---|---|
| `map` | bin — accumulated-map keyframe delta, float32 `[x,y,z,intensity] × N` |
| `depth` | bin — float32 `[x,y,z,r,g,b] × N` |
| `imu` | map `{ "orientation": [x,y,z,w], "angular_vel": [x,y,z], "linear_accel": [x,y,z] }` (decimated to 10 Hz by bridge) |
| `detections` | map `{ "boxes": [{ "center": [x,y,z], "size": [x,y,z], "yaw": float, "class_id": uint, "label": str, "confidence": float }] }` — source-agnostic: robot-side YOLO or browser-side inference both produce this shape |
| `processing` | map `{ "frame_ms": float, "icp_mean": float, "icp_std": float }` |
| `velocity` | map `{ "linear_ms": float, "angular_degs": float }` |
| `loop_closure` | map `{ "src_kf": uint, "dst_kf": uint, "error": float, "detector": str, "accepted": bool }` |
| `nav_path` | map `{ "frame": str, "poses": bin float32 [x,y,theta] × N }` |

## Commands (browser → robot)

Commands are MessagePack maps sent on the same socket. Every command carries a client-chosen
correlation `id` (uint, monotonic per connection). Replies arrive as frames with
`topic: "cmd_ack"` and echo the `id`.

### Implemented

```jsonc
// Ping — drives the latency readout
{ "cmd": "ping", "id": 7, "t": 1718000000.123 }
// → cmd_ack data:
{ "cmd": "pong", "id": 7, "t": 1718000000.123 }

// Set parameters on a robot-side node
{ "cmd": "set_param", "id": 8, "node": "slam", "params": { "voxel_size": 0.1 } }
// → cmd_ack data:
{ "cmd": "param_ack", "id": 8, "node": "slam",
  "accepted": { "voxel_size": 0.1 }, "rejected": {} }
```

```jsonc
// Send a navigation goal (map frame, meters/radians)
{ "cmd": "send_goal", "id": 9, "x": 1.5, "y": 2.0, "theta": 0.0, "frame": "map" }
// → cmd_ack data (async — arrives once the planner accepts/rejects):
{ "cmd": "goal_ack", "id": 9, "goal_id": "g-001", "accepted": true, "message"?: str }
// progress then flows on the nav_status channel, correlated by goal_id;
// "succeeded" / "aborted" / "canceled" are terminal.

{ "cmd": "cancel_goal", "id": 10, "goal_id": "g-001" }
// → cmd_ack data: { "cmd": "cancel_ack", "id": 10, "ok": true }
```

## Backpressure

High-rate droppable channels (`scan`, later `map`/`depth`) MUST be dropped — never queued — when a
client's send buffer backs up. A slow client sees a lower scan rate; it never stalls other clients
and never receives stale frames. Low-rate channels (`stats`, `log`, `status`, `cmd_ack`) are
delivered reliably in order.

## Versioning & fixtures

Golden fixture frames live in `bridge/tests/fixtures/*.bin` with `expected.json` describing their
decoded content. Python generates them (`bridge/tests/gen_fixtures.py`); both the Python and
TypeScript test suites decode and assert. Any change to this document requires regenerating
fixtures and reviewing both suites.
