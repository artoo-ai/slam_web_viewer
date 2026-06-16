/** Per-component SLAM diagnostics — one reactive slot per component. These
 *  channels are low-rate (1-2 Hz), so reactive Zustand is fine (no polling
 *  feed needed). Each slot stamps the CLIENT receive time on the monotonic
 *  performance.now() clock (ms) — the same clock the panels read for staleness,
 *  matching stalenessFeed and sidestepping robot↔browser wall-clock skew. */

import { create } from 'zustand'
import type {
  OdomDiagPayload,
  SlamToolboxDiagPayload,
  Nav2DiagPayload,
  RtabmapDiagPayload,
} from '../types/channels'

export interface DiagSlot<T> {
  /** client receive time in ms on the performance.now() clock, or null */
  ts: number | null
  data: T | null
}

interface DiagState {
  rf2o: DiagSlot<OdomDiagPayload>
  fastlio: DiagSlot<OdomDiagPayload>
  slamToolbox: DiagSlot<SlamToolboxDiagPayload>
  nav2: DiagSlot<Nav2DiagPayload>
  rtabmap: DiagSlot<RtabmapDiagPayload>
  setRf2o: (d: OdomDiagPayload) => void
  setFastlio: (d: OdomDiagPayload) => void
  setSlamToolbox: (d: SlamToolboxDiagPayload) => void
  setNav2: (d: Nav2DiagPayload) => void
  setRtabmap: (d: RtabmapDiagPayload) => void
}

const EMPTY = { ts: null, data: null }

export const useDiagnosticsStore = create<DiagState>((set) => ({
  rf2o: EMPTY,
  fastlio: EMPTY,
  slamToolbox: EMPTY,
  nav2: EMPTY,
  rtabmap: EMPTY,
  setRf2o: (data) => set({ rf2o: { ts: performance.now(), data } }),
  setFastlio: (data) => set({ fastlio: { ts: performance.now(), data } }),
  setSlamToolbox: (data) => set({ slamToolbox: { ts: performance.now(), data } }),
  setNav2: (data) => set({ nav2: { ts: performance.now(), data } }),
  setRtabmap: (data) => set({ rtabmap: { ts: performance.now(), data } }),
}))
