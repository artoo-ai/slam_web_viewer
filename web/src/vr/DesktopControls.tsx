import { OrbitControls } from '@react-three/drei'
import { useXR } from '@react-three/xr'

/** Mouse orbit/zoom for the flat desktop view. Suppressed during an XR session
 *  so it never fights headset head-tracking. */
export function DesktopControls() {
  const inXR = useXR((s) => s.session != null)
  if (inXR) return null
  return <OrbitControls makeDefault target={[0, 0, 0.5]} />
}
