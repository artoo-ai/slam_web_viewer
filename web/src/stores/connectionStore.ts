import { create } from 'zustand'
import type { HelloPayload } from '../types/channels'

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

interface ConnectionState {
  status: ConnectionStatus
  latencyMs: number | null
  hello: HelloPayload | null
  /** frames whose seq skipped ahead — per-session drop counter */
  drops: number
  setStatus: (status: ConnectionStatus) => void
  setLatency: (ms: number) => void
  setHello: (hello: HelloPayload) => void
  addDrops: (n: number) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'connecting',
  latencyMs: null,
  hello: null,
  drops: 0,
  setStatus: (status) => set({ status }),
  setLatency: (latencyMs) => set({ latencyMs }),
  setHello: (hello) => set({ hello }),
  addDrops: (n) => set((s) => ({ drops: s.drops + n })),
}))
