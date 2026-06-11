/** Wire protocol v1 — TypeScript side. See docs/protocol.md (source of truth).
 *  Worker-safe: no DOM access. */

import { encode } from '@msgpack/msgpack'

export const PROTOCOL_VERSION = 1

export const CH = {
  HELLO: 'hello',
  SCAN: 'scan',
  POSE: 'pose',
  STATS: 'stats',
  LOG: 'log',
  STATUS: 'status',
  CMD_ACK: 'cmd_ack',
} as const

export const SCAN_STRIDE_FLOATS = 4 // x, y, z, intensity
export const SCAN_STRIDE_BYTES = 16

/** Commands (browser -> robot). Every command carries a correlation id. */
export interface PingCommand {
  cmd: 'ping'
  id: number
  t: number
}

export interface SetParamCommand {
  cmd: 'set_param'
  id: number
  node: string
  params: Record<string, unknown>
}

export type Command = PingCommand | SetParamCommand

/** Omit that distributes over unions (plain Omit collapses Command to common keys). */
export type DistributiveOmit<T, K extends keyof never> = T extends unknown
  ? Omit<T, K>
  : never

/** A command as callers provide it — the connection assigns the correlation id. */
export type CommandInput = DistributiveOmit<Command, 'id'>

export function encodeCommand(command: Command): Uint8Array {
  return encode(command)
}

/** msgpack bin payloads arrive as Uint8Array views at arbitrary byteOffset —
 *  copy into a fresh, 4-byte-aligned Float32Array (also makes it transferable). */
export function toAlignedFloat32(view: Uint8Array): Float32Array {
  const out = new Float32Array(view.byteLength / 4)
  new Uint8Array(out.buffer).set(view)
  return out
}
