import { Canvas } from '@react-three/fiber'
import { XR } from '@react-three/xr'
import { SceneContent } from './SceneContent'
import { SceneRoot } from '../../vr/SceneRoot'
import { DesktopControls } from '../../vr/DesktopControls'
import { Locomotion } from '../../vr/Locomotion'
import { VoidBackdrop } from '../../vr/VoidBackdrop'
import { VrDebugMarker } from '../../vr/VrDebugMarker'
import { xrStore } from '../../vr/xrStore'
import { VrHud } from '../../vr/VrHud'

/** One Canvas for both desktop and VR, wrapped in <XR> (always mounted, so fiber's
 *  XR render loop is set up correctly from the start). With no session it renders
 *  the flat desktop scene (DesktopControls → OrbitControls + DOM chrome); on
 *  enterVR()/enterAR() the headset takes over and SceneRoot reorients to Y-up.
 *  The flat page renders fine because offerSession is disabled (see xrStore). */
export function ViewportCanvas() {
  return (
    <Canvas
      camera={{ position: [-6, -6, 4], up: [0, 0, 1], fov: 60, near: 0.05, far: 400 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      style={{ background: 'var(--bg)' }}
    >
      <XR store={xrStore}>
        <DesktopControls />
        <Locomotion />
        <VoidBackdrop />
        <VrDebugMarker />
        <SceneRoot>
          <SceneContent />
        </SceneRoot>
        <VrHud />
      </XR>
    </Canvas>
  )
}
