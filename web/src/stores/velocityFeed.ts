/** Velocity comparison ring buffer (cmd vs odom) + smear detection.
 *
 *  Smear condition (the rf2o-loses-rotation signature): commanded |wz| above
 *  SPIN_THRESHOLD while measured |wz| is under FOLLOW_RATIO of it, sustained
 *  for SUSTAIN_S. While true, slam_toolbox is being fed rotating scans with a
 *  "stationary" odom seed — ghost walls imminent. */

import type { VelocityPayload } from '../types/channels'

const WINDOW_S = 30
const RATE_HZ = 10
const CAPACITY = WINDOW_S * RATE_HZ

const SPIN_THRESHOLD = 0.3 // rad/s commanded
const FOLLOW_RATIO = 0.3
const SUSTAIN_S = 0.5

// parallel ring buffers (uPlot consumes plain arrays per series)
const t: number[] = []
const cmdWz: number[] = []
const odomWz: number[] = []
const cmdVx: number[] = []
const odomVx: number[] = []

let version = 0
let mismatchSince: number | null = null
let smearing = false

export const velocityFeed = {
  push(payload: VelocityPayload, ts: number) {
    t.push(ts)
    cmdWz.push(payload.cmd.wz)
    odomWz.push(payload.odom.wz)
    cmdVx.push(payload.cmd.vx)
    odomVx.push(payload.odom.vx)
    if (t.length > CAPACITY) {
      t.shift()
      cmdWz.shift()
      odomWz.shift()
      cmdVx.shift()
      odomVx.shift()
    }

    const mismatch =
      Math.abs(payload.cmd.wz) > SPIN_THRESHOLD &&
      Math.abs(payload.odom.wz) < FOLLOW_RATIO * Math.abs(payload.cmd.wz)
    if (mismatch) {
      mismatchSince ??= ts
      smearing = ts - mismatchSince >= SUSTAIN_S
    } else {
      mismatchSince = null
      smearing = false
    }
    version++
  },
  get series(): [number[], number[], number[], number[], number[]] {
    return [t, cmdWz, odomWz, cmdVx, odomVx]
  },
  get version() {
    return version
  },
  /** true while commanded rotation is not being tracked by odometry */
  get smearing() {
    return smearing
  },
  get latest(): VelocityPayload | null {
    const i = t.length - 1
    if (i < 0) return null
    return { cmd: { vx: cmdVx[i], wz: cmdWz[i] }, odom: { vx: odomVx[i], wz: odomWz[i] } }
  },
}
