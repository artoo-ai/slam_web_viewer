import { create } from 'zustand'

/** Local rendering parameters (never touch the robot). */

export type ColorMode = 'intensity' | 'height'

interface ViewerParams {
  pointSize: number
  colorMode: ColorMode
  /** z range for the height ramp, meters */
  heightMin: number
  heightMax: number
  voiceAlerts: boolean
  setPointSize: (v: number) => void
  setColorMode: (v: ColorMode) => void
  setVoiceAlerts: (v: boolean) => void
}

export const useViewerParams = create<ViewerParams>((set) => ({
  pointSize: 3.0,
  colorMode: 'intensity',
  heightMin: 0.0,
  heightMax: 2.5,
  voiceAlerts: false,
  setPointSize: (pointSize) => set({ pointSize }),
  setColorMode: (colorMode) => set({ colorMode }),
  setVoiceAlerts: (voiceAlerts) => set({ voiceAlerts }),
}))
