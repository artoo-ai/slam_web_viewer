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

// exploration-stall detector: EXPLORING but coverage flat for STALL_MS
const STALL_MS = 120_000
let lastCells: number | null = null
let lastGrowth = performance.now()
let lastState: string | null = null

const TERMINAL_OK = /COMPLETE|DONE|FINISH|SUCCESS/i

function checkTransitions(m: MissionPayload) {
  if (m.state !== lastState) {
    if (TERMINAL_OK.test(m.state)) {
      void import('./alertsStore').then((a) =>
        a.useAlertsStore.getState().raise('exploration-complete'))
    }
    lastState = m.state
  }
}

function checkStall(m: MissionPayload) {
  const cells = Number(m.fields['free_cells_mapped'])
  if (!Number.isFinite(cells)) return
  const now = performance.now()
  if (lastCells === null || cells > lastCells) {
    lastCells = cells
    lastGrowth = now
    return
  }
  if (m.state === 'EXPLORING' && now - lastGrowth > STALL_MS) {
    void import('./alertsStore').then((a) => a.useAlertsStore.getState().raise('exploration-stalled'))
  }
}

export const useMissionStore = create<MissionState>((set) => ({
  mission: null,
  setMission: (ts, m) => {
    checkStall(m)
    checkTransitions(m)
    set({ mission: { ...m, ts } })
  },
}))
