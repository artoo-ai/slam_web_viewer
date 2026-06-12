import { useEffect, useState } from 'react'
import { MONITORED, stalenessFeed, type ChannelHealth } from '../../stores/stalenessFeed'
import { useConnectionStore } from '../../stores/connectionStore'
import './chrome.css'

/** Thin strip along the viewport's top edge: per-channel age of last frame.
 *  Averages hide gaps — a 2 s scan hole starves rf2o while "10 Hz" still
 *  reads fine. Red cells = the pipeline stage that broke. */

function cellClass(h: ChannelHealth | null): string {
  if (!h) return 'stale-none'
  if (h.age < Math.max(0.2, h.nominal * 2)) return 'stale-ok'
  if (h.age < Math.max(0.5, h.nominal * 3)) return 'stale-warn'
  return 'stale-bad'
}

export function StalenessStrip() {
  const status = useConnectionStore((s) => s.status)
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [])
  if (status !== 'open') return null
  return (
    <div className="stale-strip"
         title="Age of the last frame per channel (green fresh, red stale) and the worst gap in the last 60 s. A red cell shows WHERE the pipeline broke: scan red + pose green = lidar/driver; pose red too = odometry died.">
      {MONITORED.map(({ key, label, nominal }) => {
        const h = stalenessFeed.health(key)
        const showGap = h && h.worstGap > nominal * 3
        return (
          <span key={key} className={`stale-cell ${cellClass(h)}`}>
            {label} {h ? `${h.age < 10 ? h.age.toFixed(1) : '>10'}s` : '—'}
            {showGap && <em> gap {h.worstGap.toFixed(1)}s</em>}
          </span>
        )
      })}
    </div>
  )
}
