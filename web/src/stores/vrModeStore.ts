import { create } from 'zustand'

export type VrSessionMode = 'none' | 'vr' | 'ar'

export const MIN_WORLD_SCALE = 0.02
export const MAX_WORLD_SCALE = 5

/** Uniform scale of the whole cloud, set by the two-handed grab gesture. */
export function clampWorldScale(scale: number): number {
  return Math.min(MAX_WORLD_SCALE, Math.max(MIN_WORLD_SCALE, scale))
}

interface VrState {
  mode: VrSessionMode
  worldScale: number
  setMode: (mode: VrSessionMode) => void
  setWorldScale: (scale: number) => void
}

export const useVrStore = create<VrState>((set) => ({
  mode: 'none',
  worldScale: 1,
  setMode: (mode) => set({ mode }),
  setWorldScale: (scale) => set({ worldScale: clampWorldScale(scale) }),
}))
