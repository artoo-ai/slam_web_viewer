import { create } from 'zustand'
import { EXPECTED_PARAMS } from '../config/expectedParams'
import { connection } from '../lib/transport/connection'

/** Deployed-config audit: diff node_params frames against the expected
 *  manifest (docs/diagnostics.md §1). A non-responding node is UNKNOWN,
 *  never OK. */

export type RowStatus = 'ok' | 'mismatch' | 'unknown' | 'info'

export interface AuditRow {
  node: string
  param: string
  deployed: unknown
  expect: unknown
  status: RowStatus
  tip: string
}

interface NodeParamsPayload {
  stamp: number
  complete: boolean
  nodes: Record<string, Record<string, unknown> | null>
}

function valuesMatch(deployed: unknown, expect: unknown): boolean {
  if (Array.isArray(expect)) {
    return (
      Array.isArray(deployed) &&
      deployed.length === expect.length &&
      expect.every((e, i) => Math.abs((deployed[i] as number) - e) < 1e-6)
    )
  }
  if (typeof expect === 'number') {
    return typeof deployed === 'number' && Math.abs(deployed - expect) < 1e-6
  }
  return deployed === expect
}

interface ParamsAuditState {
  rows: AuditRow[]
  mismatches: number
  unknowns: number
  stamp: number | null
  refresh: () => void
  apply: (payload: NodeParamsPayload) => void
}

export const useParamsAudit = create<ParamsAuditState>((set, get) => ({
  rows: [],
  mismatches: 0,
  unknowns: 0,
  stamp: null,
  refresh: () => void connection.sendCommand({ cmd: 'get_params' }),
  apply: (payload) => {
    const rows: AuditRow[] = EXPECTED_PARAMS.map((e) => {
      const node = payload.nodes[e.node]
      const deployed = node ? node[e.param] : undefined
      let status: RowStatus
      if (node == null || deployed === undefined) status = 'unknown'
      else if (e.expect === null) status = 'info'
      else status = valuesMatch(deployed, e.expect) ? 'ok' : 'mismatch'
      return { node: e.node, param: e.param, deployed, expect: e.expect, status, tip: e.tip }
    })
    const mismatches = rows.filter((r) => r.status === 'mismatch').length
    const unknowns = rows.filter((r) => r.status === 'unknown').length
    const prev = get().mismatches
    set({ rows, mismatches, unknowns, stamp: payload.stamp })
    if (mismatches > 0 && prev === 0) {
      void import('../lib/tts/ttsManager').then((m) =>
        m.speakAlert(`Warning. ${mismatches} deployed parameter${mismatches > 1 ? 's' : ''} differ from expected.`))
    }
  },
}))
