/** Low-obstacle-band feed (/scan_low → scan_low channel) — NOT a reactive
 *  store; the renderer polls `seq` in useFrame, same pattern as scanFeed.
 *  Carries the 0.05–0.15 m slice the costmap's low_obstacle_layer dodges
 *  (dog bowls, shoes) — the points the planner swerves around that the
 *  main scan layer doesn't show. */

let points: Float32Array | null = null
let count = 0
let seq = -1

export const scanLowFeed = {
  push(newPoints: Float32Array, newSeq: number) {
    points = newPoints
    count = newPoints.length / 4
    seq = newSeq
  },
  get points() {
    return points
  },
  get count() {
    return count
  },
  get seq() {
    return seq
  },
}
