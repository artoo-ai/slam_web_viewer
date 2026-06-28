import { Canvas } from '@react-three/fiber'
import { XR } from '@react-three/xr'
import { SceneContent } from './SceneContent'
import { SceneRoot } from '../../vr/SceneRoot'
import { DesktopControls } from '../../vr/DesktopControls'
import { VrDebugMarker } from '../../vr/VrDebugMarker'
import { xrStore } from '../../vr/xrStore'

/** One Canvas for both desktop and VR, wrapped in <XR>.
 *
 *  DIAGNOSTIC BUILD: the VR rig (Locomotion, VoidBackdrop, VrHud) is temporarily
 *  removed to isolate why nothing renders in a session. With no Locomotion there
 *  is no XROrigin to move the viewpoint, so if the marker/point-cloud appear the
 *  culprit was the locomotion moving the player away from the scene. */
export function ViewportCanvas() {
  return (
    <Canvas
      camera={{ position: [-6, -6, 4], up: [0, 0, 1], fov: 60, near: 0.05, far: 400 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      style={{ background: 'var(--bg)' }}
    >
      <XR store={xrStore}>
        <DesktopControls />
        <VrDebugMarker />
        <SceneRoot>
          <SceneContent />
        </SceneRoot>
      </XR>
    </Canvas>
  )
}
