import { useEffect, useState } from 'react'
import { xrStore } from '../vr/xrStore'
import { useVrStore, type VrEnvironment } from '../stores/vrModeStore'
import './vrEntry.css'

/** DOM buttons (visible only on the flat page) to start an immersive session.
 *  WebXR forbids auto-entry — a user tap is required, so these live in the DOM
 *  chrome, not in-scene. Hidden entirely on browsers without WebXR.
 *
 *  WebXR can't hot-swap session types, so we run ONE session and toggle void ↔
 *  passthrough in-scene (VoidBackdrop). When immersive-ar is available (Quest 3)
 *  BOTH buttons enter the same AR session and just pick the initial environment —
 *  that's what makes the in-HUD switch work. If only immersive-vr exists, we fall
 *  back to a VR session (always void; passthrough isn't possible there).
 *  Session mode is derived from the XR store subscribe (xrStore.ts). */
export function VrEntry() {
  const [vrOk, setVrOk] = useState(false)
  const [arOk, setArOk] = useState(false)

  useEffect(() => {
    const xr = navigator.xr
    if (!xr) return
    xr.isSessionSupported('immersive-vr').then(setVrOk).catch(() => setVrOk(false))
    xr.isSessionSupported('immersive-ar').then(setArOk).catch(() => setArOk(false))
  }, [])

  // Enter the session, choosing AR when available so passthrough is reachable.
  const enter = (environment: VrEnvironment) => {
    useVrStore.getState().setEnvironment(environment)
    const start = arOk ? xrStore.enterAR() : xrStore.enterVR()
    start.catch(() => {})
  }

  if (!vrOk && !arOk) return null
  return (
    <div className="vr-entry">
      <button onClick={() => enter('void')}>Enter VR</button>
      {arOk && <button onClick={() => enter('passthrough')}>Enter Passthrough</button>}
    </div>
  )
}
