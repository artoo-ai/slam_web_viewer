/** Payload types per channel — see docs/protocol.md (wire protocol v1). */

export interface HelloPayload {
  protocol: number
  server: 'mock' | 'ros2' | string
  channels: string[]
  app_version: string
  /** MJPEG stream names served at :8080/stream/<name> (1-4 cameras) */
  cameras?: string[]
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
  /** rate of the 2D /scan that laser odometry consumes (distinct from the 3D cloud) */
  scan2d_hz?: number
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

export interface GoalAck {
  cmd: 'goal_ack'
  id: number
  goal_id: string
  accepted: boolean
  message?: string
}

export interface CancelAck {
  cmd: 'cancel_ack'
  id: number
  ok: boolean
}

export type CmdAckPayload = PongAck | ParamAck | GoalAck | CancelAck | { cmd: string; id: number }

export type NavState =
  | 'accepted'
  | 'navigating'
  | 'succeeded'
  | 'aborted'
  | 'canceled'
  | 'rejected'

export interface NavStatusPayload {
  state: NavState
  goal_id?: string
  distance_m?: number
  eta_s?: number
  message?: string
}

export interface OccupancyGridPayload {
  /** absent = "map" (the SLAM map); costmap_global / costmap_local are Nav2 layers */
  layer?: 'map' | 'costmap_global' | 'costmap_local'
  width: number
  height: number
  resolution: number
  /** map-frame pose of cell (0,0)'s corner: [x, y, theta] */
  origin: [number, number, number]
  encoding: 'rle'
  data: Uint8Array
}

export interface NavPathPayload {
  frame: string
  /** packed float32 LE [x, y, theta] * N */
  poses: Uint8Array
}

export interface VelocityPayload {
  cmd: { vx: number; wz: number }
  odom: { vx: number; wz: number }
}

export interface ImuPayload {
  angular_vel: [number, number, number]
  linear_accel: [number, number, number]
  orientation?: [number, number, number, number]
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
