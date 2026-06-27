import { Grid } from '@react-three/drei'
import { PointCloudViewer } from './PointCloudViewer'
import { ScanLowLayer } from './ScanLowLayer'
import { ScanMainLayer } from './ScanMainLayer'
import { DepthPointsLayer } from './DepthPointsLayer'
import { MapPointsLayer } from './MapPointsLayer'
import { TrajectoryOverlay } from './TrajectoryOverlay'
import { RobotPoseGlyph } from './RobotPoseGlyph'
import { OccupancyGridLayer } from './OccupancyGridLayer'
import { PathOverlay } from './PathOverlay'
import { GoalClickPlane, GoalMarker } from './GoalControls'
import { ObjectMarkers } from './ObjectMarkers'
import { ViewportBridge } from './ViewportBridge'

/** Every 3D layer of the scene, with no camera/controls. Shared verbatim by the
 *  desktop Canvas and the VR (XR) shell so new layers appear in both automatically. */
export function SceneContent() {
  return (
    <>
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
      <ScanMainLayer />
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
    </>
  )
}
