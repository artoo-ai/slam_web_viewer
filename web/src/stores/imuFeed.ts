/** IMU ring buffer (gyro xyz + accel xyz), 30 s at 10 Hz — same pattern as
 *  velocityFeed. The panel polls `version` on a timer. */

import type { ImuPayload } from '../types/channels'

const CAPACITY = 300

const t: number[] = []
const gx: number[] = []
const gy: number[] = []
const gz: number[] = []
let latest: ImuPayload | null = null
let version = 0

export const imuFeed = {
  push(payload: ImuPayload, ts: number) {
    latest = payload
    t.push(ts)
    gx.push(payload.angular_vel[0])
    gy.push(payload.angular_vel[1])
    gz.push(payload.angular_vel[2])
    if (t.length > CAPACITY) {
      t.shift()
      gx.shift()
      gy.shift()
      gz.shift()
    }
    version++
  },
  get series(): [number[], number[], number[], number[]] {
    return [t, gx, gy, gz]
  },
  get latest() {
    return latest
  },
  get version() {
    return version
  },
}
