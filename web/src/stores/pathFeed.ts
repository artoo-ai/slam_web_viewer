/** Nav2 global plan feed — non-reactive, polled in useFrame. */

import { toAlignedFloat32 } from '../lib/transport/protocol'
import type { NavPathPayload } from '../types/channels'

let poses: Float32Array = new Float32Array(0) // [x, y, theta] * N
let version = 0

export const pathFeed = {
  push(payload: NavPathPayload) {
    poses = toAlignedFloat32(payload.poses)
    version++
  },
  /** flat [x, y, theta] * N */
  get poses() {
    return poses
  },
  get count() {
    return poses.length / 3
  },
  get version() {
    return version
  },
}
