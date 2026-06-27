import { useEffect, useState } from 'react'
import { xrStore } from '../vr/xrStore'
import './vrEntry.css'

/** DOM buttons (visible only on the flat page) to start an immersive session.
 *  WebXR forbids auto-entry — a user tap is required, so these live in the DOM
 *  chrome, not in-scene. Hidden entirely on browsers without WebXR.
 *  Mode is derived from the XR store subscribe (xrStore.ts) — no optimistic setMode here. */
export function VrEntry() {
  const [vrOk, setVrOk] = useState(false)
  const [arOk, setArOk] = useState(false)

  useEffect(() => {
    const xr = navigator.xr
    if (!xr) return
    xr.isSessionSupported('immersive-vr').then(setVrOk).catch(() => setVrOk(false))
    xr.isSessionSupported('immersive-ar').then(setArOk).catch(() => setArOk(false))
  }, [])

  if (!vrOk && !arOk) return null
  return (
    <div className="vr-entry">
      {vrOk && (
        <button onClick={() => xrStore.enterVR().catch(() => {})}>
          Enter VR
        </button>
      )}
      {arOk && (
        <button onClick={() => xrStore.enterAR().catch(() => {})}>
          Enter Passthrough
        </button>
      )}
    </div>
  )
}
