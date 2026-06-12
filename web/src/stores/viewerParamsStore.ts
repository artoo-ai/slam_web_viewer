import { create } from 'zustand'

/** Local rendering parameters (never touch the robot). */

export type ColorMode = 'intensity' | 'height'
export type FollowMode = 'free' | 'chase' | 'top'

interface ViewerParams {
  pointSize: number
  colorMode: ColorMode
  gamma: number
  follow: FollowMode
  /** z range for the height ramp, meters */
  heightMin: number
  heightMax: number
  voiceAlerts: boolean
  setPointSize: (v: number) => void
  setColorMode: (v: ColorMode) => void
  setGamma: (v: number) => void
  setFollow: (v: FollowMode) => void
  setVoiceAlerts: (v: boolean) => void
}

export const useViewerParams = create<ViewerParams>((set) => ({
  pointSize: 1.5,
  colorMode: 'intensity',
  gamma: 1.0,
  follow: 'free',
  heightMin: 0.0,
  heightMax: 2.5,
  voiceAlerts: true,
  setPointSize: (pointSize) => set({ pointSize }),
  setColorMode: (colorMode) => set({ colorMode }),
  setGamma: (gamma) => set({ gamma }),
  setFollow: (follow) => set({ follow }),
  setVoiceAlerts: (voiceAlerts) => set({ voiceAlerts }),
}))
