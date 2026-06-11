import { useEffect, useState } from 'react'
import { useConnectionStore } from '../../stores/connectionStore'
import { scanFeed } from '../../stores/scanFeed'
import { connection } from '../../lib/transport/connection'
import './panels.css'

/** Bottom status bar: connection badge, latency, scan rate, point count, drops.
 *  Scan figures come from the non-reactive feed, sampled at 2 Hz. */
export function StatusBar() {
  const status = useConnectionStore((s) => s.status)
  const latencyMs = useConnectionStore((s) => s.latencyMs)
  const drops = useConnectionStore((s) => s.drops)
  const hello = useConnectionStore((s) => s.hello)
  const [scan, setScan] = useState({ hz: 0, count: 0 })

  useEffect(() => {
    const timer = setInterval(
      () => setScan({ hz: scanFeed.hz, count: scanFeed.count }),
      500,
    )
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      <span className="status-badge">
        <span className={`status-dot ${status}`} />
        {status === 'open' ? `${hello?.server ?? '?'} @ ${connection.url}` : status}
      </span>
      <span>{latencyMs !== null && status === 'open' ? `${latencyMs} ms` : '— ms'}</span>
      <span>scan {scan.hz.toFixed(1)} Hz</span>
      <span>{scan.count.toLocaleString()} pts</span>
      <span>{drops} dropped</span>
    </>
  )
}
