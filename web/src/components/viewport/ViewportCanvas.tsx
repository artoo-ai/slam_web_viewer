import { Canvas } from '@react-three/fiber'
import { XR } from '@react-three/xr'
import { SceneContent } from './SceneContent'
import { SceneRoot } from '../../vr/SceneRoot'
import { DesktopControls } from '../../vr/DesktopControls'
import { Locomotion } from '../../vr/Locomotion'
import { VoidBackdrop } from '../../vr/VoidBackdrop'
import { xrStore } from '../../vr/xrStore'
import { VrHud } from '../../vr/VrHud'

/** One Canvas for both desktop and VR. Wrapped in <XR>: with no session it
 *  renders the flat desktop scene (OrbitControls + DOM chrome). On enterVR()/
 *  enterAR() the headset takes over and SceneRoot reorients to Y-up. */
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
        <SceneRoot>
          <SceneContent />
        </SceneRoot>
        <VrHud />
      </XR>
    </Canvas>
  )
}
