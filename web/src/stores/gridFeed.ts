/** Occupancy grid feed — same non-reactive pattern as scanFeed. Updates at
 *  ~0.5 Hz; the renderer polls `version` in useFrame. Cells are decoded from
 *  RLE here (once per frame received, off the render path). */

import { decodeGridRle } from '../lib/transport/protocol'
import type { OccupancyGridPayload } from '../types/channels'

export interface GridSnapshot {
  width: number
  height: number
  resolution: number
  origin: [number, number, number]
  /** flat row-major cells: 0..100 occupancy, 255 unknown */
  cells: Uint8Array
}

let latest: GridSnapshot | null = null
let version = 0

export const gridFeed = {
  push(payload: OccupancyGridPayload) {
    if (payload.encoding !== 'rle') return // unknown encodings ignored per protocol
    latest = {
      width: payload.width,
      height: payload.height,
      resolution: payload.resolution,
      origin: payload.origin,
      cells: decodeGridRle(payload.data, payload.width * payload.height),
    }
    version++
  },
  get latest() {
    return latest
  },
  get version() {
    return version
  },
}
