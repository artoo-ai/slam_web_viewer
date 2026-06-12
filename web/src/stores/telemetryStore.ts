import { create } from 'zustand'
import type { LogPayload, StatsPayload, StatusPayload } from '../types/channels'

export interface LogEntry extends LogPayload {
  ts: number
  key: number
  /** consecutive repeats of the same line, collapsed into one entry */
  repeats: number
}

const LOG_CAP = 500

/** strip the bridge's "(+n suppressed)" suffix so repeats collapse cleanly */
function normalize(message: string): string {
  return message.replace(/\s*\(\+\d+ suppressed\)\s*$/, '')
}

interface TelemetryState {
  stats: StatsPayload | null
  logs: LogEntry[]
  lastStatusEvent: (StatusPayload & { ts: number }) | null
  setStats: (stats: StatsPayload) => void
  addLog: (ts: number, log: LogPayload) => void
  setStatusEvent: (ts: number, status: StatusPayload) => void
}

let logKey = 0
let scan2dDeadFor = 0 // consecutive 1 Hz stats frames with scan2d at ~0

export const useTelemetryStore = create<TelemetryState>((set) => ({
  stats: null,
  logs: [],
  lastStatusEvent: null,
  setStats: (stats) => {
    if (stats.scan2d_hz !== undefined) {
      scan2dDeadFor = stats.scan2d_hz < 1 ? scan2dDeadFor + 1 : 0
      if (scan2dDeadFor >= 3) {
        void import('./alertsStore').then((m) => m.useAlertsStore.getState().raise('scan2d-dead'))
      }
    }
    set({ stats })
  },
  addLog: (ts, log) =>
    set((s) => {
      void import('./alertsStore').then((m) => m.useAlertsStore.getState().ingest(log.message))
      const last = s.logs[s.logs.length - 1]
      if (last && last.level === log.level &&
          normalize(last.message) === normalize(log.message)) {
        // collapse consecutive repeats into one entry with a counter
        const collapsed = { ...last, ts, repeats: last.repeats + 1 }
        return { logs: [...s.logs.slice(0, -1), collapsed] }
      }
      return {
        logs: [...s.logs.slice(-(LOG_CAP - 1)),
               { ...log, message: normalize(log.message), ts, key: logKey++, repeats: 1 }],
      }
    }),
  setStatusEvent: (ts, status) => set({ lastStatusEvent: { ...status, ts } }),
}))
