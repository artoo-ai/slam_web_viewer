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
  OCCUPANCY_GRID: 'occupancy_grid',
  NAV_STATUS: 'nav_status',
  NAV_PATH: 'nav_path',
  VELOCITY: 'velocity',
  IMU: 'imu',
  MAP: 'map',
  OBJECTS: 'objects',
  MISSION: 'mission',
  SCAN_LOW: 'scan_low',
  SCAN_MAIN: 'scan_main',
  DEPTH: 'depth',
  // per-component SLAM diagnostics (DiagnosticsCard)
  RF2O_DIAG: 'rf2o_diag',
  FASTLIO_DIAG: 'fastlio_diag',
  SLAM_TOOLBOX_DIAG: 'slam_toolbox_diag',
  NAV2_DIAG: 'nav2_diag',
  RTABMAP_DIAG: 'rtabmap_diag',
  // capability flag in hello.channels: server accepts cmd_vel teleop
  TELEOP: 'teleop',
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

export interface SendGoalCommand {
  cmd: 'send_goal'
  id: number
  x: number
  y: number
  theta: number
  frame: 'map'
}

export interface CancelGoalCommand {
  cmd: 'cancel_goal'
  id: number
  goal_id?: string
}

export interface RecStartCommand {
  cmd: 'rec_start'
  id: number
  path?: string
}

export interface RecStopCommand {
  cmd: 'rec_stop'
  id: number
}

export interface MapSaveCommand {
  cmd: 'map_save'
  id: number
  path?: string
}

export interface GetParamsCommand {
  cmd: 'get_params'
  id: number
  node?: string
}

/** Teleop body twist (REP-103: vx forward m/s, wz CCW rad/s). Streamed while a
 *  control is held; fire-and-forget (no ack). The bridge clamps and applies a
 *  deadman, so a missing stream stops the robot. */
export interface CmdVelCommand {
  cmd: 'cmd_vel'
  id: number
  vx: number
  wz: number
}

export type Command =
  | PingCommand
  | SetParamCommand
  | SendGoalCommand
  | CancelGoalCommand
  | RecStartCommand
  | RecStopCommand
  | MapSaveCommand
  | GetParamsCommand
  | CmdVelCommand

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

/** Cell value for "unknown" in decoded occupancy grids (ROS int8 -1 as uint8). */
export const GRID_UNKNOWN = 255

/** Decode the occupancy_grid RLE payload: 3-byte records [uint8 value, uint16 LE
 *  run]. Returns a flat row-major Uint8Array of exactly nCells (0..100, 255). */
export function decodeGridRle(data: Uint8Array, nCells: number): Uint8Array {
  if (data.byteLength % 3 !== 0) throw new Error(`RLE length ${data.byteLength} not multiple of 3`)
  const out = new Uint8Array(nCells)
  let cell = 0
  for (let i = 0; i < data.byteLength; i += 3) {
    const value = data[i]
    const run = data[i + 1] | (data[i + 2] << 8)
    if (cell + run > nCells) throw new Error('RLE overflows grid')
    out.fill(value, cell, cell + run)
    cell += run
  }
  if (cell !== nCells) throw new Error(`RLE decoded ${cell} cells, expected ${nCells}`)
  return out
}
