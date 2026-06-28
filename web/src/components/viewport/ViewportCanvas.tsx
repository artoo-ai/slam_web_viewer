import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { XR } from '@react-three/xr'
import { SceneContent } from './SceneContent'
import { SceneRoot } from '../../vr/SceneRoot'
import { Locomotion } from '../../vr/Locomotion'
import { VoidBackdrop } from '../../vr/VoidBackdrop'
import { XrAutoEnter } from '../../vr/XrAutoEnter'
import { VrDebugMarker } from '../../vr/VrDebugMarker'
import { xrStore } from '../../vr/xrStore'
import { VrHud } from '../../vr/VrHud'
import { useVrStore } from '../../stores/vrModeStore'

/** One Canvas for both desktop and VR. The flat desktop scene renders WITHOUT the
 *  <XR> wrapper — mounting <XR> with no active session freezes the render loop, so
 *  we mount it (and the VR rig) only once the user taps Enter VR (xrActive). On
 *  session end xrStore unmounts it again, restoring the flat scene. */
export function ViewportCanvas() {
  const xrActive = useVrStore((s) => s.xrActive)
  return (
    <Canvas
      camera={{ position: [-6, -6, 4], up: [0, 0, 1], fov: 60, near: 0.05, far: 400 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      style={{ background: 'var(--bg)' }}
    >
      {xrActive ? (
        <XR store={xrStore}>
          <XrAutoEnter />
          <VrDebugMarker />
          <Locomotion />
          <VoidBackdrop />
          <SceneRoot>
            <SceneContent />
          </SceneRoot>
          <VrHud />
        </XR>
      ) : (
        <>
          <OrbitControls makeDefault target={[0, 0, 0.5]} />
          <SceneContent />
        </>
      )}
    </Canvas>
  )
}
