import { useEffect, useState } from 'react'
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

  // Probe WebXR support. The localhost IWER emulator injects navigator.xr
  // asynchronously (and REPLACES the object), so a one-shot check on mount can
  // race it and miss. Re-read navigator.xr and re-probe for a few seconds until
  // support appears; on a real headset the first probe already succeeds.
  useEffect(() => {
    let cancelled = false
    let supported = false
    const probe = () => {
      const xr = navigator.xr
      if (!xr) return
      void xr.isSessionSupported('immersive-vr').then((v) => {
        if (cancelled) return
        setVrOk(v)
        if (v) supported = true
      })
      void xr.isSessionSupported('immersive-ar').then((v) => {
        if (cancelled) return
        setArOk(v)
        if (v) supported = true
      })
    }
    probe()
    const interval = setInterval(() => {
      if (supported) clearInterval(interval)
      else probe()
    }, 500)
    const stop = setTimeout(() => clearInterval(interval), 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
      clearTimeout(stop)
    }
  }, [])

  // Mount <XR> and queue the session entry (XrAutoEnter performs it once the WebXR
  // manager is connected). Choose AR when available so passthrough is reachable.
  const enter = (environment: VrEnvironment) => {
    useVrStore.getState().requestEnter(environment, arOk)
  }

  if (!vrOk && !arOk) return null
  return (
    <div className="vr-entry">
      <button onClick={() => enter('void')}>Enter VR</button>
      {arOk && <button onClick={() => enter('passthrough')}>Enter Passthrough</button>}
    </div>
  )
}
