/** High-rate scan feed — NOT a reactive store. The renderer polls `seq` in
 *  useFrame; no React re-renders at scan rate. */

let points: Float32Array | null = null
let count = 0
let seq = -1
let ts = 0
let hz = 0

// scan-rate estimate over a sliding 2 s window
const arrivals: number[] = []

export const scanFeed = {
  push(newPoints: Float32Array, newSeq: number, newTs: number) {
    points = newPoints
    count = newPoints.length / 4
    seq = newSeq
    ts = newTs
    const now = performance.now()
    arrivals.push(now)
    while (arrivals.length > 0 && arrivals[0] < now - 2000) arrivals.shift()
    hz = arrivals.length / 2
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
  get ts() {
    return ts
  },
  get hz() {
    return hz
  },
}
