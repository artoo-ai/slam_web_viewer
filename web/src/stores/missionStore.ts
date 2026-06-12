import { create } from 'zustand'

/** High-level mission state (exploration etc.) — low rate, reactive. */

export interface MissionPayload {
  state: string
  fields: Record<string, number | string>
}

interface MissionState {
  mission: (MissionPayload & { ts: number }) | null
  setMission: (ts: number, m: MissionPayload) => void
}

export const useMissionStore = create<MissionState>((set) => ({
  mission: null,
  setMission: (ts, m) => set({ mission: { ...m, ts } }),
}))
