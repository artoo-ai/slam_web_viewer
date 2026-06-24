# Robot GUI — SLAM / Navigation Web Viewer

Purpose-built, browser-based 3D viewer for a robot SLAM stack (Livox Mid-360 + RealSense D435 on a
Unitree Go2 / Jetson Orin Nano Super, running FAST-LIO2 + RTABMap + Nav2). Replaces RViz2/Foxglove
with one fixed, opinionated layout.

**The browser has zero ROS2 dependency.** A bridge process on the robot pushes MessagePack-encoded
binary frames over a plain WebSocket; the camera streams as MJPEG over HTTP. ROS2 is only used
robot-side during the MVP phase and can be replaced later by touching only the bridge.

## Layout

| Path | What |
|---|---|
| `docs/protocol.md` | Wire protocol spec — the single source of truth |
| `web/` | Vite + React 19 + TypeScript + React Three Fiber viewer |
| `bridge/` | Python package: mock data generator + rclpy bridge (Jetson) |

## Quickstart (no robot needed)

```bash
./install_mac.sh        # once: bridge deps (uv or venv) + npm install
```

Terminal 1 — mock data generator (synthesizes a room, a moving robot, LiDAR scans,
and a progressively-explored occupancy grid):

```bash
./start_bridge.sh mock
```

Terminal 2 — web viewer:

```bash
cd web
npm run dev
```

Open http://localhost:5173 — you should see a live synthetic point-cloud room, the robot's
trajectory, and the full panel stack: camera (MJPEG from `:8080/stream/rgb`, `?cam=` overrides),
layer toggles (map / costmaps / path), rotation tracking with the map-smear alarm, navigation
(double-click the floor to send a goal), parameters (point size, intensity/height color mode,
remote set_param), IMU, stats, and log. The viewer connects to `ws://localhost:9090` by default;
override with `?ws=ws://host:port` or `VITE_BRIDGE_URL`. Voice alerts (Web Speech) are opt-in via
the Parameters panel.

## Live data (Jetson + ROS2 Humble)

The rclpy bridge subscribes to FAST-LIO2 (`/cloud_registered_body`, `/Odometry`) and republishes
over the same wire protocol — the viewer doesn't change at all.

One-time setup on the Jetson (creates `bridge/.venv-ros` with `--system-site-packages` so rclpy
from the ROS2 env stays importable):

```bash
# copy the repo over (no remote yet): rsync -a --exclude node_modules --exclude '.venv*' \
#   ~/Documents/Robots/robot_gui/ jetson@gizmo.local:~/robot_gui/
cd ~/robot_gui
./install_jetson.sh
```

Terminal 1 — on the Jetson, run the bridge (after the SLAM stack is up). `start_bridge.sh` sources
ROS2 and bootstraps the venv itself, so it also works standalone without the install step:

```bash
cd ~/robot_gui
./start_bridge.sh 2d    # slam_toolbox stack (start_slam_2d.sh / start_explore_2d.sh)
./start_bridge.sh 3d    # FAST-LIO2/RTABMap stack (start_fast_lio.sh / start_rtabmap.sh)
# extra args pass through, e.g.:
#   ./start_bridge.sh 3d --decimate 2          lighter point stream over WiFi
#   ./start_bridge.sh 2d --map-topic /my_map   override a preset topic ('' disables)
```

Terminal 2 — on the Mac, start the web viewer (same as Quickstart; the viewer is always served
from your Mac, never the robot):

```bash
cd web
npm run dev
```

Then open the browser on the Mac and point the viewer at the robot with `?ws=` (the
viewer is on localhost, only the WebSocket targets the Jetson):

```
http://localhost:5173/?ws=ws://gizmo.local:9090
```

### Manual drive (joystick)

When the bridge advertises teleop, a **Manual Drive** joystick appears top-right (toggle
it under the sidebar). **Arm** it, then drag the pad or hold **W A S D / arrow keys** to
stream `cmd_vel` to the robot. Releasing the pad/keys, hitting **STOP**, disconnecting, or
even closing the tab halts the robot — the bridge runs a deadman (default 0.4 s) that
publishes a zero `Twist` the moment the stream lapses. Commands are clamped to
`--teleop-max-vx` / `--teleop-max-wz` (0.5 m/s, 0.6 rad/s) robot-side.

```bash
./start_bridge.sh 2d                              # teleop on, publishes /cmd_vel
./start_bridge.sh 2d --no-teleop                  # read-only viewer (no joystick)
./start_bridge.sh 2d --teleop-topic /cmd_vel_teleop   # feed a twist_mux input instead
```

**The robot only moves if a base driver is consuming `/cmd_vel`.** The viewer bridge
*publishes* `/cmd_vel` — it does not drive motors. On the slam_bringup rover the consumer
is `yahboom_bridge_node`, which is **off by default** in the 2D stack
(`enable_drive:=false`). If the joystick changes `/cmd_vel` but the rover sits still, the
motor driver isn't running. Start it (in the slam_bringup repo):

```bash
./start_yahboom.sh                    # standalone motor driver (no SLAM restart)
# or bring it up with the stack:
./start_slam_2d.sh enable_drive:=true
```

Verify the chain — the count must be **≥ 2** (the bridge's own velocity readout **plus**
the motor driver). If it's `1`, only the bridge is on the topic and nothing drives:

```bash
ros2 topic info /cmd_vel               # Publisher count: 1, Subscription count: ≥ 2
ros2 topic info /cmd_vel -v            # read the node names to see WHO subscribes
```

**Speed and turn rate.** Commands are clamped to `--teleop-max-vx` / `--teleop-max-wz`
(default **0.5 m/s**, **0.6 rad/s**) robot-side, and the in-UI speed slider scales both. The
0.6 rad/s default matches the deployed `max_vel_theta` and turns slowly by hand — raise it
for snappier rotation:

```bash
./start_bridge.sh 2d --teleop-max-wz 1.5      # quicker turns
```

The rover **also** clamps angular speed in `yahboom_bridge_node` (its `max_wz` param), so if
turning still feels capped after raising `--teleop-max-wz`, that param is the next ceiling.
On a mecanum chassis, "drifts sideways instead of turning" usually means the stick is
**diagonal** (any forward component arcs the path) — for a pure pivot push the pad fully
left/right with zero forward; the yahboom log should read `cmd_vel → vx=+0.000 vy=+0.000
wz=±…`.

**Running manual drive alongside Nav2 (twist_mux).** Driving `/cmd_vel` directly fights
the autonomous stack — they share one topic, and the higher-rate publisher wins
unpredictably. `install_jetson.sh` installs `twist_mux` for this; a ready config ships at
[`config/twist_mux.yaml`](config/twist_mux.yaml) (teleop priority 100 > nav 10, each with
a 0.5 s release timeout). To use it:

```bash
# point Nav2's controller/velocity_smoother output at /cmd_vel_nav (slam_bringup),
# then let start_bridge launch the muxer and feed it /cmd_vel_teleop:
./start_bridge.sh 2d --with-mux
```

`--with-mux` runs [`start_twist_mux.sh`](start_twist_mux.sh) (its output owns `/cmd_vel`)
and stops it again when the bridge exits. You can also run the muxer on its own —
`./start_twist_mux.sh` — e.g. to keep it up across bridge restarts.

Releasing the joystick goes silent, the teleop input times out after 0.5 s, and Nav2
takes back `/cmd_vel` automatically. For **manual-only** driving (Nav2 idle) you don't
need any of this — the default `/cmd_vel` works straight into `yahboom_bridge`.

The mock (`./start_bridge.sh mock`) also accepts the joystick: it can't move its fixed
loop, but it reflects the command into the Rotation Tracking panel so you can exercise
the full control before trusting it on hardware.

Status: the rclpy bridge runs live on the 2D stack — scan, pose, trajectory, ping latency,
and **teleop driving the rover via `/cmd_vel`** are all confirmed on hardware.
`stats`/`status` channels are not emitted by it yet (those panels show "waiting for data").

## Tests

```bash
cd bridge && uv run pytest          # protocol roundtrip + fixtures + mock smoke
cd web && npx vitest run            # cross-language golden-fixture contract tests
```

## Manual verification checklist

- Orbit/pan/zoom feels right with z-up; grid is the floor
- Scan refreshes ~10×/s; 60 fps while orbiting
- Trajectory closes into a loop after one lap; pose arrow glides smoothly
- Kill the mock → status badge goes red; restart → auto-reconnects within ~5 s
- Stats tick at 1 Hz; a loop-closure log line appears each lap
