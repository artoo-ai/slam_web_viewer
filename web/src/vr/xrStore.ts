import { createXRStore } from '@react-three/xr'
import { useVrStore } from '../stores/vrModeStore'

/** Single XR session store for the app. `enterVR()` / `enterAR()` start the
 *  immersive session; hand-tracking enabled so the grab/teleport gestures work
 *  with controllers or hands. */
export const xrStore = createXRStore({ hand: true, controller: true })

// Reset the store's mode whenever the session ends (system Meta button, etc.)
xrStore.subscribe((state) => {
  if (state.session == null) useVrStore.getState().setMode('none')
})
