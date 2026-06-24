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

> With Nav2 running, driving `/cmd_vel` directly fights the autonomous stack. Point
> `--teleop-topic` at a `twist_mux` input (e.g. `/cmd_vel_teleop`) so manual and Nav2
> commands are prioritized rather than colliding.

The mock (`./start_bridge.sh mock`) also accepts the joystick: it can't move its fixed
loop, but it reflects the command into the Rotation Tracking panel so you can exercise
the full control before trusting it on hardware.

Status: the rclpy bridge compiles and is unit-tested ROS-free, but has not yet been run against
real hardware. `stats`/`log`/`status` channels are not emitted by it yet (panels show
"waiting for data" — scan, pose, trajectory, and ping latency all work).

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
