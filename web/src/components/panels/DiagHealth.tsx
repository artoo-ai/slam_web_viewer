import { useEffect, useState } from 'react'
import { useConnectionStore } from '../../stores/connectionStore'
import { ageSeconds } from './diagFormat'
import './panels.css'

/** Health pill for a diagnostics tab. Three states, derived the same way the
 *  rest of the app derives them:
 *   - inactive: the channel isn't in the bridge's `hello.channels` (the other
 *     stack is running) → "inactive — not in this stack".
 *   - stale: the channel exists but no frame arrived within 3× nominal.
 *   - active: fresh frames flowing.
 *  `ts` is the client receive time (ms) from diagnosticsStore. */
export function DiagHealth({
  channel,
  ts,
  nominal = 1.0,
  inactiveHint,
}: {
  channel: string
  ts: number | null
  nominal?: number
  inactiveHint?: string
}) {
  const hello = useConnectionStore((s) => s.hello)
  // re-render on a timer; time is read from the monotonic performance.now()
  // clock (the same one diagnosticsStore stamps with), matching StalenessStrip
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [])

  // before the bridge announces channels, assume active rather than flashing
  // "inactive" — hello arrives within the first frame anyway
  const inStack = hello?.channels ? hello.channels.includes(channel) : true
  const age = ageSeconds(ts)

  let cls = 'diag-active'
  let label = 'active'
  let title = 'Receiving fresh diagnostics frames.'
  if (!inStack) {
    cls = 'diag-inactive'
    label = 'inactive — not in this stack'
    title = inactiveHint ?? 'This component is not running in the current SLAM stack.'
  } else if (age > nominal * 3) {
    cls = 'diag-stale'
    label = ts === null ? 'no data yet' : `stale ${age < 100 ? age.toFixed(0) : '99+'}s`
    title = 'The channel is advertised but frames have stopped — the node may be down.'
  }

  return (
    <div className={`diag-health ${cls}`} title={title}>
      <span className="diag-dot" />
      {label}
    </div>
  )
}

/** Small key/value row used across the diagnostics panels. */
export function DiagRow({
  k,
  children,
  tip,
  warn,
}: {
  k: string
  children: React.ReactNode
  tip?: string
  warn?: boolean
}) {
  return (
    <div className="diag-row" title={tip}>
      <span className="diag-k">{k}</span>
      <span className={`diag-v${warn ? ' diag-v-warn' : ''}`}>{children}</span>
    </div>
  )
}
