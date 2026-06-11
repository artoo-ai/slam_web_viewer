/** Payload types per channel — see docs/protocol.md (wire protocol v1). */

export interface HelloPayload {
  protocol: number
  server: 'mock' | 'ros2' | string
  channels: string[]
  app_version: string
}

export interface PosePayload {
  p: [number, number, number]
  q: [number, number, number, number]
  frame: string
}

export interface StatsPayload {
  keyframes: number
  total_pts: number
  distance_m: number
  duration_s: number
  scan_hz: number
  health: number
  clients: number
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogPayload {
  level: LogLevel
  message: string
}

export interface StatusPayload {
  event: string
  label?: string
  count?: number
}

/** cmd_ack payloads, correlated by `id` */
export interface PongAck {
  cmd: 'pong'
  id: number
  t: number
}

export interface ParamAck {
  cmd: 'param_ack'
  id: number
  node: string
  accepted: Record<string, unknown>
  rejected: Record<string, unknown>
}

export type CmdAckPayload = PongAck | ParamAck | { cmd: string; id: number }

export interface OccupancyGridPayload {
  width: number
  height: number
  resolution: number
  /** map-frame pose of cell (0,0)'s corner: [x, y, theta] */
  origin: [number, number, number]
  encoding: 'rle'
  data: Uint8Array
}

/** A decoded frame as posted from the decoder worker to the main thread. */
export interface DecodedFrame {
  topic: string
  ts: number
  seq: number
  /** map payloads — absent for scan */
  data?: unknown
  /** scan only: aligned, transferable copy of the bin payload */
  points?: Float32Array
}
