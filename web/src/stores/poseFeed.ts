/** High-rate pose feed + trajectory ring buffer — NOT a reactive store.
 *  The renderer polls `version` in useFrame. */

import type { PosePayload } from '../types/channels'

const TRAJECTORY_CAPACITY = 20_000
const MIN_SEGMENT_M = 0.02 // decimate: skip points closer than 2 cm to the last kept one

// trajectory stored as a flat [x,y,z]*N append-only ring (wraps by shifting halves)
const trajectory = new Float32Array(TRAJECTORY_CAPACITY * 3)
let trajCount = 0

let latest: PosePayload | null = null
let version = 0

function appendTrajectory(x: number, y: number, z: number) {
  if (trajCount > 0) {
    const i = (trajCount - 1) * 3
    const dx = x - trajectory[i]
    const dy = y - trajectory[i + 1]
    const dz = z - trajectory[i + 2]
    if (dx * dx + dy * dy + dz * dz < MIN_SEGMENT_M * MIN_SEGMENT_M) return
  }
  if (trajCount === TRAJECTORY_CAPACITY) {
    // drop the oldest half so appends stay O(1) amortized
    trajectory.copyWithin(0, (TRAJECTORY_CAPACITY / 2) * 3)
    trajCount = TRAJECTORY_CAPACITY / 2
  }
  const i = trajCount * 3
  trajectory[i] = x
  trajectory[i + 1] = y
  trajectory[i + 2] = z
  trajCount++
}

export const poseFeed = {
  push(pose: PosePayload) {
    latest = pose
    appendTrajectory(pose.p[0], pose.p[1], pose.p[2])
    version++
  },
  get latest() {
    return latest
  },
  get version() {
    return version
  },
  /** Flat [x,y,z]*capacity buffer — read only the first `trajectoryCount` points. */
  get trajectory() {
    return trajectory
  },
  get trajectoryCount() {
    return trajCount
  },
}
