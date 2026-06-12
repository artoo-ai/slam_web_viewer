import { Canvas } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import { PointCloudViewer } from './PointCloudViewer'
import { ScanLowLayer } from './ScanLowLayer'
import { DepthPointsLayer } from './DepthPointsLayer'
import { MapPointsLayer } from './MapPointsLayer'
import { TrajectoryOverlay } from './TrajectoryOverlay'
import { RobotPoseGlyph } from './RobotPoseGlyph'
import { OccupancyGridLayer } from './OccupancyGridLayer'
import { PathOverlay } from './PathOverlay'
import { GoalClickPlane, GoalMarker } from './GoalControls'
import { ObjectMarkers } from './ObjectMarkers'
import { ViewportBridge } from './ViewportBridge'

/** The 3D scene. World is REP-103 z-up — camera.up must be set before
 *  OrbitControls initializes, hence via the camera prop. preserveDrawingBuffer
 *  keeps toBlob() screenshots valid. */
export function ViewportCanvas() {
  return (
    <Canvas
      camera={{ position: [-6, -6, 4], up: [0, 0, 1], fov: 60, near: 0.05, far: 400 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      style={{ background: 'var(--bg)' }}
    >
      <OrbitControls makeDefault target={[0, 0, 0.5]} />
      <ViewportBridge />
      {/* drei Grid lies in the XZ plane by default — rotate onto XY (the floor) */}
      <Grid
        rotation={[Math.PI / 2, 0, 0]}
        args={[40, 40]}
        cellSize={1}
        cellColor="#2a3546"
        sectionSize={5}
        sectionColor="#3b4a61"
        fadeDistance={60}
        infiniteGrid
      />
      <axesHelper args={[1]} />
      <PointCloudViewer />
      <ScanLowLayer />
      <DepthPointsLayer />
      <MapPointsLayer />
      <TrajectoryOverlay />
      <RobotPoseGlyph />
      <OccupancyGridLayer layer="map" palette="map" z={0.01} />
      <OccupancyGridLayer layer="costmap_global" palette="cost" z={0.02} />
      <OccupancyGridLayer layer="costmap_local" palette="cost" z={0.03} />
      <PathOverlay />
      <GoalClickPlane />
      <GoalMarker />
      <ObjectMarkers />
    </Canvas>
  )
}
