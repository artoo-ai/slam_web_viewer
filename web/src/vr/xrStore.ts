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
// Covers system-granted sessions that bypass the DOM entry buttons. On session
// end, also unmount <XR> (exitXr) so the flat page renders normally again.
// state.session?: XRSession (undefined when no session); state.mode: XRSessionMode | null
xrStore.subscribe((state) => {
  if (state.session == null) {
    useVrStore.getState().setMode('none')
    useVrStore.getState().exitXr()
    return
  }
  useVrStore.getState().setMode(state.mode === 'immersive-ar' ? 'ar' : 'vr')
})
