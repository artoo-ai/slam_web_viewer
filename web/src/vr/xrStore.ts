import { createXRStore } from '@react-three/xr'
import { useVrStore } from '../stores/vrModeStore'

/** Single XR session store for the app. `enterVR()` / `enterAR()` start the
 *  immersive session; hand + controller tracking enabled for the gestures.
 *
 *  Two things must stay off so they don't freeze the flat desktop render loop:
 *  - emulate: false — the IWER Quest emulator injects at store-creation (on
 *    localhost) and patches the frame loop, killing requestAnimationFrame on the
 *    flat page. (Headset-free desktop VR testing is the cost; the real Quest is
 *    unaffected since it has real WebXR.)
 *  - offerSession: false — don't auto-offer a session to the UA.
 *  Separately, <XR> itself is only mounted while entering/in VR (see
 *  ViewportCanvas) for the same reason. */
export const xrStore = createXRStore({
  hand: true,
  controller: true,
  offerSession: false,
  emulate: false,
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
