/** Main nav/SLAM band feed (/scan → scan_main channel) — NOT a reactive
 *  store; the renderer polls `seq` in useFrame, same pattern as scanFeed.
 *  Carries the points pointcloud_to_laserscan flattens into the 2D /scan that
 *  slam_toolbox and the costmap's main obstacle_layer consume — i.e. which
 *  slice of the 3D cloud actually drives mapping and obstacle avoidance. */

let points: Float32Array | null = null
let count = 0
let seq = -1

export const scanMainFeed = {
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
