import type { ReactNode } from 'react'
import { useXR } from '@react-three/xr'
import { useVrStore } from '../stores/vrModeStore'
import { Z_UP_TO_Y_UP } from './coords'

/** Wraps the shared scene. Only inside an active XR session does it reorient
 *  Z-up→Y-up and apply the grabbed world scale; on the flat desktop (no session)
 *  it is the identity so OrbitControls behaves exactly as before. (<XR> is always
 *  mounted, so this session check is reliable.) */
export function SceneRoot({ children }: { children: ReactNode }) {
  const inXR = useXR((s) => s.session != null)
  const worldScale = useVrStore((s) => s.worldScale)
  // Guard against a stray 0/NaN scale ever collapsing the scene to nothing.
  const safeScale = Number.isFinite(worldScale) && worldScale > 0 ? worldScale : 1
  return (
    <group rotation={inXR ? Z_UP_TO_Y_UP : [0, 0, 0]} scale={inXR ? safeScale : 1}>
      {children}
    </group>
  )
}
