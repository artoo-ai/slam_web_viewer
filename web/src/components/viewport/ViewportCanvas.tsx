import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { SceneContent } from './SceneContent'

/** Desktop 3D scene. World is REP-103 z-up — camera.up must be set before
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
      <SceneContent />
    </Canvas>
  )
}
