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

// Derive vrModeStore.mode from the XR session state — single source of truth.
// Use prevState so we only react to real transitions: while ENTERING (session
// still null as the manager connects) we must NOT fire exitXr — that would
// unmount <XR> mid-entry. Only a non-null→null transition is a true session end.
// state.session?: XRSession (undefined when no session); state.mode: XRSessionMode | null
xrStore.subscribe((state, prev) => {
  const has = state.session != null
  const had = prev.session != null
  if (has) {
    useVrStore.getState().setMode(state.mode === 'immersive-ar' ? 'ar' : 'vr')
  } else if (had) {
    // real session end → restore the flat page
    useVrStore.getState().setMode('none')
    useVrStore.getState().exitXr()
  }
})
