import { useEffect } from 'react'
import { useVrStore } from '../stores/vrModeStore'
import { xrStore } from './xrStore'

/** Mounted inside <XR> (only while xrActive). On mount the WebXR manager is
 *  connected, so this is the right moment to actually request the session — still
 *  within the user activation from the Enter button tap. On failure we unmount
 *  <XR> again so the flat page keeps rendering. Renders nothing. */
export function XrAutoEnter() {
  useEffect(() => {
    const pending = useVrStore.getState().consumePending()
    if (!pending) return
    const start = pending.ar ? xrStore.enterAR() : xrStore.enterVR()
    start.catch(() => useVrStore.getState().exitXr())
  }, [])
  return null
}
