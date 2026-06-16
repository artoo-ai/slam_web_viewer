# SLAM-component diagnostics tabs — design

**Date:** 2026-06-14
**Status:** approved (design); implementation pending
**Scope:** add per-component visualize/troubleshoot tabs to robot_gui for the five
SLAM stack components — **rf2o, slam_toolbox, nav2, rtabmap, fast-lio2**.

## 1. Goal

Give each SLAM component its own diagnostics panel so a problem can be isolated to
one stage at a glance: "is rf2o producing odometry at rate?", "is slam_toolbox's
pose-graph growing and how much is map→odom correcting?", "what recovery is Nav2
running?", "is rtabmap closing loops?", "is FAST-LIO2's odometry steady or
diverging?". This is a troubleshooting/teaching surface (Rico records with it), not
a control surface.

### Non-goals
- No new control commands (goal sending, param setting already exist elsewhere).
- No new 3D viewport layers — these tabs are data panels, not scene geometry.
- No replacement of the existing `MetricsCard` tabs (Status/Motion/Objects/Config/Log).

## 2. Key constraints (from the existing codebase)

- Only **one stack runs at a time**: 2d = rf2o + slam_toolbox + nav2; 3d = fast-lio2
  + rtabmap (+ nav2 optionally). So at any moment ~3 of the 5 tabs have live data.
  All 5 tabs are always shown; the others render an **inactive / stale** state.
- The wire protocol (`docs/protocol.md`) is the contract: frames are MessagePack maps
  `{topic, ts, seq, data}`. Diagnostics payloads are **map payloads** (not binary),
  **reliable** (not in `DROPPABLE_CHANNELS`), **low-rate (1–2 Hz)**.
- Active/inactive is derivable two ways, both already present: the `hello` payload's
  `channels` list (which diag channels the bridge advertises for this stack) and
  `stalenessFeed` (age of last frame). We use `hello.channels` for "in this stack?"
  and staleness for "alive vs stale".
- rf2o (`/odom`, 2d) and fast-lio2 (`/Odometry`, 3d) are the **same** odom→`pose`
  subscription depending on stack. One bridge loop feeds whichever is live; the other
  tab shows "inactive — not in this stack".

## 3. Architecture

```
ROS topic ──► ros2 bridge callback/loop ──► protocol.<diag>_payload ──► broadcast(CH_<DIAG>)
                                                                              │  (reliable, 1–2 Hz)
                                                              WebSocket / MessagePack
                                                                              ▼
web: connection.ts demux  ──►  diagnosticsStore (Zustand, reactive)  ──►  DiagnosticsCard tabs
```

- **One new floating card**: `DiagnosticsCard`, docked **bottom-left**, **collapsible**,
  toggled from the `Sidebar` (mirrors the existing layer toggles). `MetricsCard` stays
  bottom-center; the two never overlap.
- **One new reactive store** `diagnosticsStore` holding `{rf2o, slam_toolbox, nav2,
  rtabmap, fastlio}`, each `{ ts: number | null, data: <PerComponentPayload> | null }`.
  Low rate ⇒ reactive Zustand is fine (same choice as missionStore/objectsStore).
- **Five new panel components** under `components/panels/`, each `PanelShell` + a shared
  `DiagHealth` header.

## 4. New wire-protocol channels

Five channels, all reliable map payloads. Constants added to both `protocol.py`
(`CH_RF2O_DIAG = "rf2o_diag"`, etc.) and `web/.../protocol.ts` `CH`.

### 4.1 `rf2o_diag` (stack=2d) / `fastlio_diag` (stack=3d)
Same builder shape (`odom_diag_payload`), different channel + `source` label.
```jsonc
{
  "source": "rf2o" | "fastlio",
  "hz": 12.4,                 // odom publish rate (1 s window), Hz
  "pose": [x, y, yaw],        // map/odom-frame, meters + rad
  "vel": { "vx": 0.0, "wz": 0.0 },   // body twist from Odometry.twist
  "cov_trace": 0.03 | null,   // trace of pose covariance if non-zero, else null
  "jump": false,              // pose step > JUMP_M since last sample (divergence)
  "age_s": 0.08               // s since last odom msg (bridge-side)
}
```
Source: existing `/odom`|`/Odometry` subscription (`on_odom`); a 1 Hz `odom_diag_loop`
computes `hz` from a frame counter (mirrors `scan_hz`), reads latest pose/vel, flags
jumps. Emitted under `rf2o_diag` when `stack==2d`, `fastlio_diag` when `stack==3d`.

### 4.2 `slam_toolbox_diag` (stack=2d, map present)
```jsonc
{
  "map": { "w": 384, "h": 384, "res": 0.05, "known_m2": 41.2, "updates": 37, "update_hz": 0.5 },
  "graph": { "nodes": 128, "edges": 130 } | null,   // null until graph viz seen
  "correction": { "dist_m": 0.04, "yaw_deg": 1.3 } | null,  // latest map→odom delta
  "mode": "mapping" | "localization" | null         // from config audit if known
}
```
Sources: existing `on_map` (we already compute `map_updates`, `map_known_m2`; store the
last grid's w/h/res); new subscription to `/slam_toolbox/graph_visualization`
(`visualization_msgs/MarkerArray`) to count graph nodes/edges (points across the node
and edge markers); TF `map→odom` for correction magnitude (already computed for the 3d
re-bake in `_check_map_correction`; reuse for the 2d odom frame). A 1 Hz
`slam_toolbox_diag_loop` assembles it.

### 4.3 `nav2_diag` (nav2 present)
```jsonc
{
  "state": "navigating" | "idle" | "succeeded" | "aborted" | ...,  // from nav_status
  "bt_node": "FollowPath" | null,          // active BT node from behavior_tree_log
  "recoveries": { "total": 3, "last": "Spin" } ,  // recovery actions counted
  "plan_poses": 42,                        // last /plan length
  "cmd": { "vx": 0.12, "wz": 0.0 },        // latest controller cmd (from velocity)
  "servers": { "planner": true, "controller": true } | null  // liveness if known
}
```
Sources: existing `nav_status` (state/dist/eta), `nav_path` (plan length), `velocity`
(cmd); new subscription to `/behavior_tree_log` (`nav2_msgs/BehaviorTreeLog`,
try/except import) for the active BT node and to detect recovery actions
(node names `Spin`, `BackUp`, `Wait`, `ClearCostmap*`) transitioning to `RUNNING`.
A loop (or event-driven on BT log) emits `nav2_diag`, rate-limited to ≤2 Hz.

### 4.4 `rtabmap_diag` (stack=3d, rtabmap present)
```jsonc
{
  "loop_total": 5,            // cumulative loop closures (count of loopClosureId>0)
  "loop_last_id": 87 | null,  // node id of the last closure
  "proximity": 2,             // cumulative proximity detections
  "ref_id": 412,              // current node id (refId)
  "proc_ms": 38.0 | null,     // processing time from Info.stats if present
  "wm_size": 120 | null,      // working-memory size if present
  "words": 350 | null,        // current-frame words/features if present
  "localized": true | null    // /rtabmap/localization_pose seen recently
}
```
Source: new subscription to `/rtabmap/info` (`rtabmap_msgs/Info`, try/except import —
the message package only exists when rtabmap is installed). Field extraction is
**defensive**: `refId`, `loopClosureId`, `proximityDetectionId` are stable; the stats
dict keys vary by rtabmap version, so pull `proc_ms`/`wm_size`/`words` best-effort and
leave `null` when absent. Rate-limited to ≤2 Hz. Optional: track
`/rtabmap/localization_pose` presence for `localized`.

## 5. Frontend

- `lib/transport/protocol.ts`: add the 5 `CH` constants.
- `types/channels.ts`: add `Rf2oDiagPayload` (shared by rf2o/fastlio), `SlamToolboxDiagPayload`,
  `Nav2DiagPayload`, `RtabmapDiagPayload`.
- `stores/diagnosticsStore.ts` (new): reactive store, one setter per component stamping `ts`.
- `lib/transport/connection.ts`: 5 new `case` branches routing each channel into the store.
- `stores/layersStore.ts`: add a `diagnostics` boolean toggle (default true).
- `components/chrome/DiagnosticsCard.tsx` (new): collapsible card; tab bar
  `rf2o | slam_toolbox | nav2 | rtabmap | fast-lio2`; per-tab tooltip; renders the active
  panel. Active/inactive computed from `connectionStore.hello.channels` + staleness.
- `components/panels/DiagHealth.tsx` (new): shared header pill — `active` (green) /
  `inactive — not in this stack` (grey) / `stale Ns` (amber/red).
- `components/panels/{Rf2o,SlamToolbox,Nav2,Rtabmap,FastLio}Panel.tsx` (new): one per tab.
  rf2o & fast-lio2 panels share a small `OdomDiag` body component (same payload shape).
  rf2o reuses the rotation mini-chart idea (uPlot) for hz/wz over time; others are
  key/value blocks like the Status tab.
- `app/Layout.tsx`: mount `<DiagnosticsCard />`.
- `components/chrome/Sidebar.tsx`: add the Diagnostics toggle.
- CSS: extend `chrome.css` for `.diag-card` (bottom-left, collapsible) and `.diag-health`.

## 6. Mock support (offline demo)

`mock/__main__.py` emits **all five** diag channels with plausible synthetic values so
every panel is fully demoable on the Mac (Rico records with the mock). One channel
carries a deliberate fault state for demo (e.g. rf2o `jump`/low `hz` episode aligned
with the existing 20 s smear episode; a Nav2 recovery burst). Documented caveat: on
real hardware only the running stack's tabs populate; the mock shows all five at once.
Add the 5 channel names to mock `CHANNELS` and the loops to `run()`.

## 7. Inactive / stale handling

- Tab whose diag channel ∉ `hello.channels` ⇒ `DiagHealth` shows **inactive — not in
  this stack**, panel body shows a one-line explanation (e.g. "rtabmap runs in the 3D
  stack; start `./start_bridge.sh 3d`").
- Channel present but no frame within `3 × nominal` ⇒ **stale Ns** (amber → red),
  using `stalenessFeed` (add the 5 diag keys to `MONITORED` with nominal 1.0 s).

## 8. Verification plan

1. **Mock, all panels populate**: `./start_bridge.sh mock` + `npm run dev`; confirm each
   of the 5 tabs shows live values; confirm the deliberate fault state renders.
2. **Headless screenshot** of each tab via Chrome `--headless=new --screenshot` (the
   project's established verification method) for the design review.
3. **Inactive state**: temporarily drop a channel from mock `CHANNELS` (or stop bridge)
   and confirm the inactive/stale treatment.
4. **Hardware (Jetson)**: `./start_bridge.sh 2d` → rf2o/slam_toolbox/nav2 populate,
   rtabmap/fastlio inactive; `./start_bridge.sh 3d` → fastlio/rtabmap populate,
   rf2o/slam_toolbox inactive. Verify rtabmap_msgs/nav2_msgs imports degrade gracefully
   when absent (no crash, channel simply not advertised).
5. **No regressions**: existing tabs, scan/grid/path rendering, goal sending unaffected.

## 9. File-by-file touch list

**Bridge**
- `bridge/src/robot_bridge/protocol.py` — 5 channel consts; `odom_diag_payload`,
  `slam_toolbox_diag_payload`, `nav2_diag_payload`, `rtabmap_diag_payload`.
- `bridge/src/robot_bridge/ros2/__main__.py` — channel-list additions (stack-aware);
  graph-viz, behavior-tree-log, rtabmap Info subscriptions (try/except for optional
  msg packages); `odom_diag_loop`, `slam_toolbox_diag_loop`, `nav2_diag` emit,
  `rtabmap_diag` emit; store last map dims; reuse correction calc for 2d.
- `bridge/src/robot_bridge/mock/__main__.py` — `CHANNELS` += 5; diag loops; run() wiring.
- `docs/protocol.md` — document the 5 channels + payload schemas.

**Frontend**
- `web/src/lib/transport/protocol.ts` — `CH` consts.
- `web/src/types/channels.ts` — 4 payload interfaces.
- `web/src/stores/diagnosticsStore.ts` — new.
- `web/src/stores/stalenessFeed.ts` — `MONITORED` += 5 diag keys.
- `web/src/stores/layersStore.ts` — `diagnostics` toggle.
- `web/src/lib/transport/connection.ts` — 5 demux cases.
- `web/src/components/chrome/DiagnosticsCard.tsx` — new.
- `web/src/components/panels/DiagHealth.tsx` — new.
- `web/src/components/panels/{Rf2o,SlamToolbox,Nav2,Rtabmap,FastLio}Panel.tsx` — new.
- `web/src/components/chrome/Sidebar.tsx` — toggle.
- `web/src/app/Layout.tsx` — mount card.
- `web/src/components/chrome/chrome.css` (+ `panels.css`) — `.diag-card`, `.diag-health`.

## 10. Risks / open points

- **Optional ROS message packages** (`rtabmap_msgs`, `nav2_msgs/BehaviorTreeLog`): import
  inside try/except; if missing, skip the subscription and don't advertise the channel —
  the tab then reads "inactive" rather than crashing the bridge.
- **slam_toolbox graph topic name**: assumed `/slam_toolbox/graph_visualization`
  (`visualization_msgs/MarkerArray`); make it a `--slam-graph-topic` arg with that
  default so it's overridable if the deployed name differs.
- **rtabmap Info stats keys** vary by version — extraction stays best-effort/null-safe.
- Two floating cards: the Diagnostics card is collapsible and docked opposite the
  MetricsCard to avoid occlusion; verify on a small viewport.
