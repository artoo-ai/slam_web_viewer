import { Canvas } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import { PointCloudViewer } from './PointCloudViewer'
import { TrajectoryOverlay } from './TrajectoryOverlay'
import { RobotPoseGlyph } from './RobotPoseGlyph'
import { OccupancyGridLayer } from './OccupancyGridLayer'

/** The 3D scene. World is REP-103 z-up — camera.up must be set before
 *  OrbitControls initializes, hence via the camera prop. */
export function ViewportCanvas() {
  return (
    <Canvas
      camera={{ position: [-6, -6, 4], up: [0, 0, 1], fov: 60, near: 0.05, far: 200 }}
      gl={{ antialias: true }}
      style={{ background: 'var(--bg)' }}
    >
      <OrbitControls makeDefault target={[0, 0, 0.5]} />
      {/* drei Grid lies in the XZ plane by default — rotate onto XY (the floor) */}
      <Grid
        rotation={[Math.PI / 2, 0, 0]}
        args={[40, 40]}
        cellSize={1}
        cellColor="#2a3546"
        sectionSize={5}
        sectionColor="#3b4a61"
        fadeDistance={45}
        infiniteGrid
      />
      <axesHelper args={[1]} />
      <PointCloudViewer />
      <TrajectoryOverlay />
      <RobotPoseGlyph />
      <OccupancyGridLayer />
    </Canvas>
  )
}
