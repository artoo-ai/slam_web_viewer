import { createXRStore } from '@react-three/xr'
import { useVrStore } from '../stores/vrModeStore'

/** Single XR session store for the app. `enterVR()` / `enterAR()` start the
 *  immersive session; hand-tracking enabled so the grab/teleport gestures work
 *  with controllers or hands. */
// The IWER emulator auto-activates only on localhost when no real WebXR device is
// present, injecting an emulated Quest 3 so the full VR flow (Enter VR, HUD,
// locomotion) can be tested in a desktop browser without a headset. This does NOT
// affect LAN-IP/HTTPS access from a real Quest or any production deployment.
export const xrStore = createXRStore({ hand: true, controller: true })

// Derive vrModeStore.mode from the XR session state — single source of truth.
// Covers system-granted sessions that bypass the DOM entry buttons.
// state.session?: XRSession (undefined when no session); state.mode: XRSessionMode | null
xrStore.subscribe((state) => {
  const next = state.session == null
    ? 'none'
    : state.mode === 'immersive-ar' ? 'ar' : 'vr'
  useVrStore.getState().setMode(next)
})
