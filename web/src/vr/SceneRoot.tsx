import type { ReactNode } from 'react'
import { useXR } from '@react-three/xr'
import { useVrStore } from '../stores/vrModeStore'
import { Z_UP_TO_Y_UP } from './coords'

/** Wraps the shared scene. Only inside an active XR session does it rotate
 *  Z-up→Y-up and apply the grabbed world scale; on the desktop (no session)
 *  it is the identity, so OrbitControls behaves exactly as before. */
export function SceneRoot({ children }: { children: ReactNode }) {
  const inXR = useXR((s) => s.session != null)
  const worldScale = useVrStore((s) => s.worldScale)
  return (
    <group
      rotation={inXR ? Z_UP_TO_Y_UP : [0, 0, 0]}
      scale={inXR ? worldScale : 1}
    >
      {children}
    </group>
  )
}
