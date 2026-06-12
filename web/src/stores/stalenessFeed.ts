/** Pipeline staleness (docs/diagnostics.md §2): per-channel age of last frame
 *  and worst inter-arrival gap over a rolling 60 s — gaps, not averages, are
 *  what starve rf2o. Client receive clock, so transport stalls count too.
 *  Non-reactive; the strip polls on a timer. */

export interface ChannelHealth {
  age: number // seconds since last frame
  worstGap: number // max inter-arrival over last 60 s
  nominal: number // expected period, seconds
}

const WINDOW_MS = 60_000

interface Track {
  last: number
  gaps: { t: number; gap: number }[]
  nominal: number
}

const tracks = new Map<string, Track>()

export const MONITORED: { key: string; label: string; nominal: number }[] = [
  { key: 'scan', label: 'scan', nominal: 0.1 },
  { key: 'pose', label: 'pose', nominal: 0.1 },
  { key: 'occupancy_grid:map', label: 'map', nominal: 2.0 },
  { key: 'occupancy_grid:costmap_local', label: 'costL', nominal: 1.0 },
  { key: 'velocity', label: 'vel', nominal: 0.1 },
]

export const stalenessFeed = {
  record(key: string) {
    const now = performance.now()
    let track = tracks.get(key)
    if (!track) {
      const nominal = MONITORED.find((m) => m.key === key)?.nominal ?? 1.0
      track = { last: now, gaps: [], nominal }
      tracks.set(key, track)
      return
    }
    track.gaps.push({ t: now, gap: (now - track.last) / 1000 })
    track.last = now
    while (track.gaps.length > 0 && track.gaps[0].t < now - WINDOW_MS) track.gaps.shift()
  },
  health(key: string): ChannelHealth | null {
    const track = tracks.get(key)
    if (!track) return null
    return {
      age: (performance.now() - track.last) / 1000,
      worstGap: track.gaps.reduce((m, g) => Math.max(m, g.gap), 0),
      nominal: track.nominal,
    }
  },
}
