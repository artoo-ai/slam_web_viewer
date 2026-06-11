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
