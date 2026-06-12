# Diagnostics & Troubleshooting Views — Spec

Additions to the wire protocol (all **additive**, protocol stays v1 per the
forward-compatibility rule) and the UI, designed around the failure modes
documented in the SLAM project's engineering log
(`~/Documents/Robots/slam/docs/DAILY_LOG.md`, 2026-06-10). Each feature names
the real incident it would have caught.

Conventions, envelope, backpressure, and fixture rules are inherited from
[protocol.md](protocol.md). New channels follow the same envelope; receivers
that don't know them ignore them. Every new channel gets a golden fixture.

---

## Priority order (one slice each)

| # | Feature | Protocol change | Would have caught |
|---|---------|-----------------|-------------------|
| 1 | Deployed-config audit | `node_params` channel + `get_params` cmd | Stale build ×3 (footprint, rotation cap, tilt script) |
| 2 | Pipeline staleness strip | none (client-side) | 2+ s `/scan` stalls starving rf2o |
| 3 | System health | `sys` channel | `Jetson Clocks: inactive`, GUI processes eating a core |
| 4 | Scan↔map alignment monitor | `diag` channel | Map smear — kill the run before the graph is poisoned |
| 5 | Scan-band z-histogram | `zhist` channel | 18.4 cm URDF height error; tilt/floor-leak hypothesis in one look |
| 6 | Session/seed card | `session` channel | Resume seeded at wrong pose / 180° off |
| 7 | Exploration trends | none (client-side) + `diag` counters | "Stuck at startup" planner-failure loop |
| 8 | Pose-graph & loop closures | `graph` channel (+ existing reserved `loop_closure`) | Bogus loop-closure edges from bad resume seed |

---

## 1. Deployed-config audit

**Problem.** Config edits do nothing until `./build.sh`, and the robot's
checkout can lag the workstation's. Three debugging sessions were derailed by
interpreting test results against params that weren't actually deployed.

### Channel `node_params`

Sent: once after `hello`, again after every `param_ack`, and on `get_params`.
Reliable (never dropped).

```jsonc
{
  "stamp": 1718000000.0,        // when the values were read
  "complete": true,             // false if any node below timed out
  "nodes": {
    "controller_server":        { "FollowPath.max_vel_theta": 0.6, ... },
    "behavior_server":          { "max_rotational_vel": 0.6, "min_rotational_vel": 0.4 },
    "velocity_smoother":        { "max_velocity": [0.5, 0.3, 0.6] },
    "local_costmap/local_costmap":   { "robot_radius": 0.25, "inflation_layer.inflation_radius": 0.30 },
    "global_costmap/global_costmap": { "robot_radius": 0.25, "inflation_layer.inflation_radius": 0.30 },
    "livox_to_scan":            { "min_height": 0.15, "max_height": 0.45 },
    "slam_toolbox":             { "mode": "mapping", "map_file_name": "", "map_start_at_dock": true }
  }
}
```

Values are raw msgpack scalars/arrays as reported by the node. A node that
doesn't respond within 2 s appears as `null` and flips `complete` to false —
the UI must render *unknown*, never *OK*.

The audited param list lives in one place on the bridge
(`robot_bridge/ros2/audit_params.py`), not scattered through code.

### Command `get_params`

```jsonc
{ "cmd": "get_params", "id": 12, "node": "controller_server" }  // node optional — absent = all audited nodes
// → cmd_ack: { "cmd": "params_ack", "id": 12, "ok": true }
// fresh node_params frame(s) follow on the channel
```

### UI — `ConfigAuditPanel`

- Expected-value manifest ships client-side
  (`web/src/config/expectedParams.ts`) with the table above as the default;
  numbers carry a tolerance (exact for booleans/strings, ±1e-6 for floats).
- Renders a checklist: param, deployed value, expected value. Mismatch rows
  red; unknown rows amber.
- Header chip: green `CONFIG ✓` / red `CONFIG ✗ n` (n = mismatch count) /
  amber `CONFIG ?`. Clicking opens the panel. Voice alert (existing opt-in
  TTS) on first mismatch detection per session.
- Refresh button issues `get_params`.

**Bridge notes.** rclpy `GetParameters` service clients, called async and
gathered with a 2 s deadline per node. Parameter *events*
(`/parameter_events`) may later push live changes; v1 is poll-on-connect +
poll-after-set + manual refresh.

---

## 2. Pipeline staleness strip (client-side only)

**Problem.** The killer wasn't low average rate — it was *gaps*: multi-second
holes in `/scan` while the Hz estimate still read "~9". Gaps starve rf2o →
TF goes stale → costmap drops messages → recoveries time out.

### UI — `StalenessStrip`

A thin fixed strip (header or viewport top edge) with one cell per monitored
channel: `scan`, `pose`, `occupancy_grid:map`, `occupancy_grid:costmap_local`,
`velocity`.

Per cell:

- **Age gauge** — seconds since last frame (client receive clock, not `ts`,
  so it also catches transport stalls). Green < 0.2 s, amber < 0.5 s, red
  ≥ 0.5 s. Red cells pulse.
- **Worst gap (60 s)** — max inter-arrival over a rolling minute, shown as
  text (`gap 2.3s`) when it exceeds 3× the channel's nominal period.
- **Inter-arrival sparkline** — last 60 s, log-scaled y so a 2 s spike is
  visible next to 100 ms ticks.

Implementation: the decoder worker already timestamps every frame; keep a
per-channel ring buffer of arrival deltas in a non-reactive feed (same
pattern as `scanFeed`), poll from `useFrame`. Zero protocol change.

A red `scan` cell concurrent with green `pose` ≠ green `scan` tells you
*where* the pipeline broke (lidar/driver vs rf2o vs bridge) — that
distinction took log-archaeology yesterday.

---

## 3. System health

**Problem.** `Jetson Clocks: inactive` (cores at 729 MHz–1.3 GHz) and a
desktop session (gnome-shell + Xorg + terminal ≈ one core) silently starved
the stack. Found only by SSHing in and running jtop.

### Channel `sys` — 1 Hz, reliable

```jsonc
{
  "cpu_pct": [43.7, 59.2, 62.9, 58.3, 63.2, 62.6],  // per core
  "cpu_freq_mhz": [1344, 1344, 729, 1344, 883, 729], // current, per core
  "cpu_freq_max_mhz": 1728,
  "mem_used_mb": 3300, "mem_total_mb": 7400,
  "swap_used_mb": 0,
  "temp_c": 54.2,                                    // hottest thermal zone
  "gpu_pct": 32.1,                                   // omitted if unavailable
  "clocks_pinned": false,                            // all cores at max freq
  "top": [ { "name": "gnome-shell", "cpu_pct": 30.1 },
           { "name": "rviz2", "cpu_pct": 22.0 },
           { "name": "warp-terminal", "cpu_pct": 18.0 } ]   // top 3 by CPU
}
```

`clocks_pinned` = every online core's current freq ≥ 95% of its max. This is
the "did you run `sudo jetson_clocks`" bit.

**Bridge notes.** psutil for cpu/mem/top;
`/sys/devices/system/cpu/cpu*/cpufreq/` for frequencies;
`/sys/class/thermal/thermal_zone*/temp` for temperature; GPU from
jetson-stats if importable, else omit (UI hides the gauge). Pure-Python,
no jtop dependency.

### UI — header chip + `SysHealthCard`

- Header chip shows hottest of: max core %, mem %, temp. Red conditions:
  `clocks_pinned == false`, any core > 90% sustained 5 s, temp > 85 °C.
  Chip text for the clock case is literal: `CLOCKS NOT PINNED`.
- Expandable card: per-core bars with freq labels, mem bar, temp, top-3
  process list (catches "RViz is running on the robot again").

---

## 4. Scan↔map alignment monitor

**Problem.** Map smear has a visible precursor — live scan walls drifting off
the accumulated map walls — but nobody is staring at the right wall at the
right moment. By the time the ring appears, the serialized graph is garbage.

### Channel `diag` — 2 Hz, reliable

One channel for cheap robot-side scalar diagnostics; keys are optional and
independent (forward-compat rule applies inside the map too):

```jsonc
{
  "scan_align": {
    "median_m": 0.034,    // median nearest-neighbor distance, live scan → map
    "p90_m": 0.11,
    "points": 1800        // sample size after decimation
  },
  "tf_age": {
    "map_odom_s": 0.06,   // now - stamp of latest map→odom
    "odom_base_s": 0.04
  },
  "loc_correction": {
    "dxy_m": 0.012,       // |Δtranslation| of map→odom since previous diag frame
    "dyaw_rad": 0.004     // |Δyaw| of map→odom since previous diag frame
  },
  "counters": {
    "planner_fail": 12,   // cumulative this session
    "recovery_spin": 3,
    "recovery_backup": 1,
    "recovery_wait": 4
  }
}
```

**Bridge notes.**

- `scan_align`: maintain a voxel hash (10 cm) of the accumulated map points
  (the `map` channel source already has them); per diag tick take ≤ 2k
  decimated live-scan points, look up nearest map point within the voxel
  neighborhood, report median/p90. O(points), no KD-tree build per tick.
- `tf_age` / `loc_correction`: tf2 buffer lookups; correction deltas are the
  frame-to-frame change of map→odom (slam_toolbox's correction). Spikes =
  the matcher fighting its seed.
- `counters`: planner failures from the `compute_path_to_pose` action result
  stream (or `/rosout` match on `failed to create plan` as fallback);
  recovery counts from the behavior server action goal topics.

### UI — `AlignmentPanel` + alarms

- uPlot strip (same pattern as VelocityPanel): `scan_align.median_m` and
  `p90_m`, 120 s window. Threshold line at 0.10 m; sustained
  `median_m > 0.10` for > 2 s → red **MAP SMEAR** banner + voice alert.
  This is the "stop driving NOW, the map is still salvageable" signal.
- `loc_correction` plotted on the same panel (secondary axis). Sustained
  large corrections right after a resume = bad seed (see §6).
- `tf_age` feeds the staleness strip (§2) as two extra cells.
- Counters feed §7.
- *Later slice:* color live scan points by residual in the viewport
  (red = off-map). Requires either bridge-side per-point residuals on the
  `scan` payload (stride change — breaking, so no) or a client-side voxel
  hash of the `map` channel. Numeric-only ships first.

---

## 5. Scan-band z-histogram

**Problem.** Two URDF errors (mount height off by 18.4 cm; suspected tilt)
were invisible until scripted floor-fitting. The question "what heights are
the points we're calling obstacles actually at?" should be one glance.

### Channel `zhist` — 1 Hz, reliable

Histogram of raw cloud z in **base_link**, computed on the bridge from the
same cloud that feeds pointcloud_to_laserscan:

```jsonc
{
  "frame": "base_link",
  "z_min": -0.50, "z_max": 1.50, "bin_m": 0.05,
  "counts": bin,                  // uint32 LE × ((z_max-z_min)/bin_m) cells
  "band": [0.15, 0.45],           // deployed scan slice (from livox_to_scan params)
  "range_gate": [0.4, 8.0]        // xy-range of points included
}
```

### UI — `ZBandPanel`

Horizontal bar chart, z on the y-axis, the `band` shaded. Healthy scene: a
hard spike at z≈0 (floor), wall mass spread above, **shaded band containing
only real obstacle heights**. Failure signatures, labeled in-UI:

- floor spike *inside* the band → height/tilt error or floor leak
  (yesterday's phantom-speckle class);
- floor spike far from z=0 → URDF stack-up wrong (the 18.4 cm bug);
- band edges vs `node_params` slice values disagree → stale build (§1
  catches it too; this makes it visual).

---

## 6. Session / seed card

**Problem.** Resume seeding now has four sources (explicit pose >
start_at_dock > `.pose` file > dock fallback) and the consequences of a wrong
seed are fatal and delayed. The seed decision currently lives in one log line
at launch.

### Channel `session` — once on connect, again if the SLAM session restarts

```jsonc
{
  "slam_mode": "mapping",            // "mapping" | "localization"
  "resume": true,
  "map_file": "/home/rico/maps/explore_latest",
  "seed_source": "pose_file",        // "explicit" | "dock_flag" | "pose_file" | "dock_fallback" | null (fresh map)
  "seed": [1.234, -0.567, 3.041],    // [x, y, theta], absent when fresh
  "seed_stamp": 1718000000.0,        // mtime of the .pose file when seed_source == "pose_file"
  "explore": { "time_limit_min": 15.0, "return_home": true }
}
```

**Bridge notes.** The bridge learns this from slam_toolbox/explore_manager
params (`mode`, `map_file_name`, `map_start_at_dock`, `map_start_pose`) — no
new ROS plumbing. `seed_source` disambiguation: explicit pose param set →
`explicit`/`pose_file` (bridge can't distinguish; the start script could
export it as a param later — acceptable v1 fuzziness, document in UI).

### UI — `SessionCard`

Shown prominently for the first 60 s after connect, then collapses into the
sidebar:

- mode, map file, seed source, seed pose, and seed file age ("written 14 h
  ago — robot must not have moved since").
- A **seed-health verdict** combining §4 signals over the first 30 s:
  `loc_correction` quiet + `scan_align.median_m` low → green "seed locked";
  sustained corrections or high residual → red "SEED LOOKS WRONG — stop and
  re-seed" + voice alert. That's the 180°-off detector, 25 m of driving
  earlier than yesterday.

---

## 7. Exploration trends (client-side + §4 counters)

**Problem.** "Stuck" looked like a robot pondering; numerically it was
free-cells growth ≈ 0 while planner failures and recovery spins climbed.

### UI — `ExploreTrendsPanel`

No new channel; consumes the existing `mission`/`stats` data plus
`diag.counters`:

- `free_cells` growth rate (cells/min, 60 s rolling slope) — the single best
  "is exploration actually progressing" number. Red when < 100 cells/min
  while state == EXPLORING for > 60 s.
- frontier count over time (rising forever + flat growth = unreachable
  frontiers = phantom obstacles or planner trouble).
- planner-failure and recovery counters as rate sparklines; a recovery-spin
  burst annotates the velocity panel timeline (spins are when smear risk
  peaks — visual correlation with §4 residual).

---

## 8. Pose-graph & loop closures (roadmap slice)

Existing reserved `loop_closure` channel stays as specced. Add:

### Channel `graph` — on change, ≤ 0.5 Hz, droppable

```jsonc
{
  "frame": "map",
  "nodes": bin,        // float32 LE [x, y] × N (graph vertex positions)
  "edges": bin,        // uint32 LE [i, j] × M — odometry chain
  "loop_edges": bin    // uint32 LE [i, j] × K — loop-closure constraints
}
```

Sourced from slam_toolbox's graph visualization topic, converted bridge-side.
UI draws nodes + edges under the map layer; `loop_edges` in a distinct color
with length labels on hover. The original resume bug ("lines that aren't
right") would be unmissable here: long edges connecting graph regions that
the map shows as different rooms.

---

## Small free wins (no spec needed, listed for tracking)

- **VelocityPanel cap line:** draw the deployed `max_vel_theta` (from
  `node_params`, fallback 0.6) as a reference line; alarm if `|cmd.wz|`
  exceeds it — live stale-build detector on existing data.
- **Staleness coloring on the header Hz readouts** once §2 lands (replace
  averages with age-aware values).
- **Log panel filters:** quick toggles for the known killer patterns
  (`failed to create plan`, `Exceeded time allowance`, `Extrapolation
  Error`, `Message Filter dropping`) with per-pattern counters.

## Fixture & test obligations

Per [protocol.md](protocol.md) versioning rules: golden fixtures for
`node_params`, `sys`, `diag`, `zhist`, `session`, `graph` (Python generates,
both suites assert). The mock server gains generators for each so every
panel is demo-able offline: a scripted "incident reel" (clock unpin at t+20 s,
scan gap at t+40 s, residual ramp at t+60 s) doubles as the UI acceptance
test.
