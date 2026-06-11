import { create } from 'zustand'
import type { LogPayload, StatsPayload, StatusPayload } from '../types/channels'

export interface LogEntry extends LogPayload {
  ts: number
  key: number
}

const LOG_CAP = 500

interface TelemetryState {
  stats: StatsPayload | null
  logs: LogEntry[]
  lastStatusEvent: (StatusPayload & { ts: number }) | null
  setStats: (stats: StatsPayload) => void
  addLog: (ts: number, log: LogPayload) => void
  setStatusEvent: (ts: number, status: StatusPayload) => void
}

let logKey = 0

export const useTelemetryStore = create<TelemetryState>((set) => ({
  stats: null,
  logs: [],
  lastStatusEvent: null,
  setStats: (stats) => set({ stats }),
  addLog: (ts, log) =>
    set((s) => ({
      logs: [...s.logs.slice(-(LOG_CAP - 1)), { ...log, ts, key: logKey++ }],
    })),
  setStatusEvent: (ts, status) => set({ lastStatusEvent: { ...status, ts } }),
}))
