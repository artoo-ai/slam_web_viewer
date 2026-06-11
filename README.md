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

Terminal 1 — mock data generator (synthesizes a room, a moving robot, LiDAR scans):

```bash
cd bridge
uv run python -m robot_bridge.mock
```

Terminal 2 — web viewer:

```bash
cd web
npm install
npm run dev
```

Open http://localhost:5173 — you should see a live synthetic point-cloud room, the robot's
trajectory, and status/stats/log panels. The viewer connects to `ws://localhost:9090` by default;
override with `?ws=ws://host:port` or `VITE_BRIDGE_URL`.

## Live data (Jetson + ROS2 Humble)

The rclpy bridge subscribes to FAST-LIO2 (`/cloud_registered_body`, `/Odometry`) and republishes
over the same wire protocol — the viewer doesn't change at all.

One-time setup on the Jetson (rclpy comes from the sourced ROS2 env, so the venv must see system
site-packages — plain `uv run` would hide it):

```bash
# copy the repo over (no remote yet): rsync -a --exclude node_modules --exclude .venv \
#   ~/Documents/Robots/robot_gui/ jetson@gizmo.local:~/robot_gui/
cd ~/robot_gui/bridge
python3 -m venv --system-site-packages .venv
.venv/bin/pip install -e .
```

Run (after the SLAM stack is up — livox_ros_driver2, FAST-LIO2):

```bash
source /opt/ros/humble/setup.bash
cd ~/robot_gui/bridge
.venv/bin/python -m robot_bridge.ros2 --host 0.0.0.0 --port 9090
# options: --decimate 2        keep every 2nd point if the stream is too heavy
#          --intensity-scale   raw intensity -> 0..1 (default 1/255 for Livox reflectivity)
```

Then on the Mac, point the viewer at the robot:

```
http://localhost:5173/?ws=ws://gizmo.local:9090
```

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
