/** Depth-camera cloud feed (latest frame, [x,y,z,r,g,b]*N) — non-reactive,
 *  polled via seq in useFrame like scanFeed. */

let points: Float32Array | null = null
let seq = -1

export const depthFeed = {
  push(newPoints: Float32Array, newSeq: number) {
    points = newPoints
    seq = newSeq
  },
  get points() {
    return points
  },
  get count() {
    return points ? points.length / 6 : 0
  },
  get seq() {
    return seq
  },
}
