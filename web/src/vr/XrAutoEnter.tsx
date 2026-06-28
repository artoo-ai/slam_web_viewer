import { useEffect } from 'react'
import { useVrStore } from '../stores/vrModeStore'
import { xrStore } from './xrStore'

/** Mounted inside <XR> (only while xrActive). On mount the WebXR manager is
 *  connected, so this is the right moment to actually request the session — still
 *  within the user activation from the Enter button tap. We unmount <XR> (exitXr)
 *  on the real session 'end' event or on entry failure — NOT by polling store
 *  state, which could misfire mid-session and tear the scene down. Renders nothing. */
export function XrAutoEnter() {
  useEffect(() => {
    const pending = useVrStore.getState().consumePending()
    if (!pending) return
    const start = pending.ar ? xrStore.enterAR() : xrStore.enterVR()
    start
      .then((session) => {
        session?.addEventListener('end', () => useVrStore.getState().exitXr())
      })
      .catch(() => useVrStore.getState().exitXr())
  }, [])
  return null
}
