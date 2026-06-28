import type { ReactNode } from 'react'
import { useVrStore } from '../stores/vrModeStore'
import { Z_UP_TO_Y_UP } from './coords'

/** Wraps the shared scene for VR. SceneRoot is only ever mounted inside the <XR>
 *  subtree (the flat desktop view renders SceneContent directly), so it ALWAYS
 *  applies the Z-up→Y-up reorientation and the grabbed world scale — no session
 *  check. (Gating on an `inXR` flag raced the conditional <XR> mount and left the
 *  scene un-rotated: floor standing up as a wall, world behind you.) */
export function SceneRoot({ children }: { children: ReactNode }) {
  const worldScale = useVrStore((s) => s.worldScale)
  return (
    <group rotation={Z_UP_TO_Y_UP} scale={worldScale}>
      {children}
    </group>
  )
}
