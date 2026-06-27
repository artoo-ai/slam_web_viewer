import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { BackSide, type Mesh } from 'three'
import { useVrStore } from '../stores/vrModeStore'

/** The void/passthrough toggle. WebXR can't switch session types at runtime, so
 *  we always run an immersive-ar session and simulate "void" here: a large
 *  inward-facing opaque sphere centered on the head fills the whole view with an
 *  opaque color (alpha 1), which hides the Quest passthrough. Removing it leaves
 *  the framebuffer transparent where nothing is drawn, so passthrough shows again.
 *
 *  Rendered outside SceneRoot (world space, unaffected by the grab-to-scale), and
 *  only while a session is active and the environment is 'void'. depthWrite is off
 *  and renderOrder is -1 so it acts purely as a background — scene geometry always
 *  draws over it regardless of distance. */
export function VoidBackdrop() {
  const mode = useVrStore((s) => s.mode)
  const environment = useVrStore((s) => s.environment)
  const ref = useRef<Mesh>(null)

  // Keep the sphere centered on the viewer so it always surrounds them.
  useFrame((state) => {
    if (ref.current) ref.current.position.copy(state.camera.position)
  })

  if (mode === 'none' || environment !== 'void') return null
  return (
    <mesh ref={ref} renderOrder={-1}>
      <sphereGeometry args={[100, 16, 16]} />
      <meshBasicMaterial color="#0b0f17" side={BackSide} depthWrite={false} fog={false} />
    </mesh>
  )
}
