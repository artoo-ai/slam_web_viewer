/** Occupancy grid feeds, one per layer (map, costmap_global, costmap_local) —
 *  same non-reactive pattern as scanFeed. The renderer polls `version` in
 *  useFrame. RLE decode happens here, once per received frame. */

import { decodeGridRle } from '../lib/transport/protocol'
import type { OccupancyGridPayload } from '../types/channels'

export type GridLayer = 'map' | 'costmap_global' | 'costmap_local'

export interface GridSnapshot {
  width: number
  height: number
  resolution: number
  origin: [number, number, number]
  /** flat row-major cells: 0..100 occupancy/cost, 255 unknown */
  cells: Uint8Array
}

interface LayerFeed {
  latest: GridSnapshot | null
  version: number
}

const feeds: Record<GridLayer, LayerFeed> = {
  map: { latest: null, version: 0 },
  costmap_global: { latest: null, version: 0 },
  costmap_local: { latest: null, version: 0 },
}

export const gridFeed = {
  push(payload: OccupancyGridPayload) {
    if (payload.encoding !== 'rle') return // unknown encodings ignored per protocol
    const layer = (payload.layer ?? 'map') as GridLayer
    const feed = feeds[layer]
    if (!feed) return // unknown layers ignored per protocol
    feed.latest = {
      width: payload.width,
      height: payload.height,
      resolution: payload.resolution,
      origin: payload.origin,
      cells: decodeGridRle(payload.data, payload.width * payload.height),
    }
    feed.version++
  },
  layer(layer: GridLayer): LayerFeed {
    return feeds[layer]
  },
}
