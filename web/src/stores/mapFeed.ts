/** Accumulated map feed: appends map-channel deltas into one big buffer.
 *  Non-reactive; the renderer polls `version` in useFrame. Tracks the bbox for
 *  the corner readout. Hard cap keeps GPU memory bounded (SJY downsamples past
 *  5M; we stop appending and surface that in the readout). */

const CAPACITY = 2_000_000 // points

const xyzi = new Float32Array(CAPACITY * 4)
let count = 0
let version = 0
let full = false

const min = [Infinity, Infinity, Infinity]
const max = [-Infinity, -Infinity, -Infinity]

export const mapFeed = {
  push(delta: Float32Array) {
    const n = Math.min(delta.length / 4, CAPACITY - count)
    if (n < delta.length / 4) full = true
    if (n <= 0) return
    xyzi.set(delta.subarray(0, n * 4), count * 4)
    for (let i = 0; i < n; i++) {
      const o = i * 4
      for (let a = 0; a < 3; a++) {
        const v = delta[o + a]
        if (v < min[a]) min[a] = v
        if (v > max[a]) max[a] = v
      }
    }
    count += n
    version++
  },
  clear() {
    count = 0
    version++
    full = false
    min.fill(Infinity)
    max.fill(-Infinity)
  },
  /** flat [x,y,z,i] * capacity — read only the first `count` points */
  get buffer() {
    return xyzi
  },
  get count() {
    return count
  },
  get version() {
    return version
  },
  get isFull() {
    return full
  },
  get bbox() {
    return count > 0 ? { min: [...min], max: [...max] } : null
  },
}
