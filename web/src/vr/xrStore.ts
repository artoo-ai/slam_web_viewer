import { createXRStore } from '@react-three/xr'
import { useVrStore } from '../stores/vrModeStore'

/** Single XR session store for the app. `enterVR()` / `enterAR()` start the
 *  immersive session; hand + controller tracking enabled for the gestures.
 *
 *  The IWER Quest emulator (default `emulate`) injects an emulated Quest 3 into
 *  `navigator.xr` on localhost, so the desktop browser shows Enter VR/Passthrough
 *  and the whole flow can be exercised without a headset. It only patches
 *  navigator.xr / userAgent / makeXRCompatible — none of which touch the flat
 *  page's render loop, so it's safe now that <XR> mounts only while in VR (see
 *  ViewportCanvas).
 *
 *  offerSession: false — don't auto-offer a session to the UA; we enter on tap. */
export const xrStore = createXRStore({
  hand: true,
  controller: true,
  offerSession: false,
})

// Derive vrModeStore.mode from the XR session state (drives the HUD/backdrop).
// PURE mode derivation only — no unmount logic here. Unmounting <XR> is driven by
// the real XRSession 'end' event in XrAutoEnter, which can't misfire mid-session
// the way polling the store could (that was unmounting the scene during VR).
xrStore.subscribe((state) => {
  useVrStore
    .getState()
    .setMode(state.session == null ? 'none' : state.mode === 'immersive-ar' ? 'ar' : 'vr')
})
