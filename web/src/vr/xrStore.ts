import { createXRStore } from '@react-three/xr'

/** Single XR session store for the app. `enterVR()` / `enterAR()` start the
 *  immersive session; hand-tracking enabled so the grab/teleport gestures work
 *  with controllers or hands. */
export const xrStore = createXRStore({ hand: true, controller: true })
