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
| `occupancy_grid` | ~0.5-2 Hz / on change | map — see below |
| `nav_status` | event + ~2 Hz while navigating | map `{ "state": "accepted"\|"navigating"\|"succeeded"\|"aborted"\|"canceled"\|"rejected", "goal_id"?: str, "distance_m"?: float, "eta_s"?: float, "message"?: str }` |
| `nav_path` | on plan change | map `{ "frame": "map", "poses": bin float32 LE [x, y, theta] × N }` — Nav2 global plan; empty `poses` clears the displayed path |
| `velocity` | 10 Hz | map `{ "cmd": { "vx": float, "wz": float }, "odom": { "vx": float, "wz": float } }` — commanded vs odometry-measured body velocities (m/s, rad/s). Divergence (cmd spinning, odom not following) is the map-smear precursor. |
| `scan_low` | ≤10 Hz | **bin** — same packing as `scan` (float32 LE `[x,y,z,intensity] × N`, map frame). The LOW obstacle band (slam_bringup `/scan_low`, 0.05–0.15 m above floor): ankle-height clutter the costmap's low_obstacle_layer dodges (dog bowls, shoes). Never fed to map accumulation; dropped without TF. Droppable channel. |
| `scan_main` | ≤10 Hz | **bin** — same packing as `scan` (float32 LE `[x,y,z,intensity] × N`, map frame). The MAIN nav/SLAM band: the height slice `[min_height, max_height]` (read at startup from the live `pointcloud_to_laserscan` node so it tracks the deployed config; `--scan-band-min`/`--scan-band-max`, default 0.15–0.45 m, are the fallback) of the 3D `scan` cloud — the points `pointcloud_to_laserscan` flattens into the 2D `/scan` that feeds slam_toolbox and the costmap's main `obstacle_layer`. Carried at TRUE height (a slab above the low band), unlike the flattened `/scan` ring. Lets the viewer show which cloud slice drives mapping/avoidance. Advertised only when the main `scan` channel is a 3D cloud; toggle off with `--no-scan-band`. Droppable channel. |
| `imu` | 10 Hz (bridge-decimated) | map `{ "angular_vel": [x,y,z] rad/s, "linear_accel": [x,y,z] m/s², "orientation"?: [x,y,z,w] }` — orientation omitted when the IMU doesn't fuse one (Mid-360 built-in doesn't) |
| `rf2o_diag` | 1 Hz (stack=2d) | map — odometry health, see below. The 2D stack's rf2o `/odom`. |
| `fastlio_diag` | 1 Hz (stack=3d) | map — same shape as `rf2o_diag`, `source: "fastlio"`. The 3D stack's FAST-LIO2 `/Odometry`. |
| `slam_toolbox_diag` | 1 Hz (stack=2d) | map — map dims/coverage, pose-graph size, map→odom correction, see below |
| `nav2_diag` | 1 Hz | map — composed nav state, active BT leaf, recovery count, plan length, controller cmd, see below |
| `rtabmap_diag` | ≤2 Hz (stack=3d) | map — loop closures, processing time, memory, see below. Needs `rtabmap_msgs`. |

Per-component **diagnostics** channels feed the viewer's DiagnosticsCard (one tab
per SLAM-stack component). They are reliable, low-rate map payloads. Only the
running stack's channels are advertised in `hello.channels` (`nav2_diag` always);
the viewer shows the other stack's tabs as "inactive". `rf2o_diag`/`fastlio_diag`
share one shape — they are the same `/odom` subscription per stack:

```jsonc
// rf2o_diag / fastlio_diag
{
  "source": "rf2o",        // "rf2o" (2d) | "fastlio" (3d)
  "hz": 12.4,              // odom publish rate, Hz (0 = odometry dead)
  "pose": [x, y, yaw],     // map/odom frame, m + rad
  "vel": { "vx": 0.4, "wz": 0.0 },
  "cov_trace": 0.02,       // pose covariance trace, or null if none published
  "jump": false,           // between-samples position jump (divergence/correction)
  "age_s": 0.08            // s since the last odom message (bridge-side)
}

// slam_toolbox_diag
{
  "map": { "w": 384, "h": 384, "res": 0.05, "known_m2": 41.2,
           "updates": 37, "update_hz": 0.5 } | null,
  "graph": { "nodes": 128, "edges": 130 } | null,   // null until graph viz seen
  "correction": { "dist_m": 0.04, "yaw_deg": 1.3 } | null,  // latest map→odom delta
  "mode": "mapping" | null
}

// nav2_diag
{
  "state": "navigating",   // "idle" | "navigating" | nav_status states
  "bt_node": "FollowPath" | null,           // active BT leaf (needs BehaviorTreeLog)
  "recoveries": { "total": 3, "last": "Spin" },
  "plan_poses": 42,
  "cmd": { "vx": 0.12, "wz": 0.0 },
  "servers": { "planner": true, "controller": true } | null
}

// rtabmap_diag
{
  "loop_total": 5, "loop_last_id": 87 | null,
  "proximity": 2, "ref_id": 412,
  "proc_ms": 38.0 | null, "wm_size": 120 | null, "words": 350 | null,
  "localized": true | null
}
```

`occupancy_grid` payload:

```jsonc
{
  "layer": "map",          // "map" | "costmap_global" | "costmap_local" (absent = "map")
  "width": 260,            // cells
  "height": 160,           // cells
  "resolution": 0.05,      // meters per cell
  "origin": [x, y, theta], // map-frame pose of cell (0,0)'s corner (ROS convention)
  "encoding": "rle",
  "data": bin              // RLE-encoded cells, row-major from origin
}
```

Cell values match ROS `nav_msgs/OccupancyGrid`: `0..100` = occupancy probability,
`255` (int8 `-1` cast to uint8) = unknown. For costmap layers the same scale carries
Nav2 cost (`1..98` gradient, `99` inscribed, `100` lethal). Costmap origins are
always expressed in the **map frame** — the bridge transforms the local costmap's
odom-frame origin before sending.

RLE encoding: a sequence of 3-byte records `[uint8 value, uint16 LE run_length]`,
run_length 1..65535. The decoded cell count MUST equal `width * height`.

`hello` payload:

```jsonc
{
  "protocol": 1,                  // protocol version
  "server": "mock",               // "mock" | "ros2"
  "channels": ["scan", "pose"],   // channels this server will publish
  "app_version": "0.1.0",
  "teleop": { "max_vx": 0.5, "max_wz": 0.6 }  // present iff teleop advertised:
}                                 // the HARD cmd_vel ceiling (m/s, rad/s). The
                                  // client maps its joystick to these and may
                                  // pick a lower effective max; the bridge
                                  // re-clamps every cmd_vel to them regardless.
```

### Reserved (documented now, implemented in later slices)

| topic | `data` (sketch) |
|---|---|
| `map` | bin — accumulated-map keyframe delta, float32 `[x,y,z,intensity] × N` |
| `depth` | bin — float32 `[x,y,z,r,g,b] × N` |
| `detections` | map `{ "boxes": [{ "center": [x,y,z], "size": [x,y,z], "yaw": float, "class_id": uint, "label": str, "confidence": float }] }` — source-agnostic: robot-side YOLO or browser-side inference both produce this shape |
| `processing` | map `{ "frame_ms": float, "icp_mean": float, "icp_std": float }` |
| `loop_closure` | map `{ "src_kf": uint, "dst_kf": uint, "error": float, "detector": str, "accepted": bool }` |

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

```jsonc
// Teleop velocity (manual drive). Body frame, REP-103: vx forward (m/s),
// wz CCW/left (rad/s). Streamed at ~10-20 Hz while a joystick/key is held.
// Fire-and-forget: NOT acked (the rate makes per-message acks pointless) — the
// commanded velocity is observable on the `velocity` channel like any other cmd.
{ "cmd": "cmd_vel", "id": 11, "vx": 0.4, "wz": -0.2 }
// The bridge CLAMPS to its configured max linear/angular speed and holds the
// latest twist, republishing it to the robot at a fixed rate. A DEADMAN applies:
// if no cmd_vel arrives within the timeout (default 0.4 s) the bridge publishes
// a single zero Twist and stops — so a released control, a closed tab, or a
// dropped connection halts the robot. The client SHOULD also send an explicit
// { "vx": 0, "wz": 0 } on release for an immediate stop.
```

A server advertises teleop support with the `teleop` capability in `hello.channels`
(a flag — no frames are published on it). The viewer shows the joystick only when
the connected server lists it; mock and read-only bridges omit it.

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
