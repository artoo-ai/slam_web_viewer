import { useEffect, useRef } from 'react'
import { useAlertsStore } from '../../stores/alertsStore'
import { velocityFeed } from '../../stores/velocityFeed'
import './chrome.css'

/** Known-issue banners, top-right corner. Each names the problem in plain
 *  language; hover for the explanation + what to check. Also watches the
 *  motion feeds so smear/cap alarms surface regardless of the active tab. */
export function AlertBanners() {
  const active = useAlertsStore((s) => s.active)
  const dismiss = useAlertsStore((s) => s.dismiss)
  const prune = useAlertsStore((s) => s.prune)
  const lastReRaise = useRef({ smear: 0, cap: 0 })

  useEffect(() => {
    const t = setInterval(prune, 5000)
    // motion watcher: raise on rising edge, then keep alive every 10 s while
    // the condition persists (so the banner's quiet-expiry doesn't drop it)
    const motion = setInterval(() => {
      const raise = useAlertsStore.getState().raise
      const now = performance.now()
      if (velocityFeed.smearing && now - lastReRaise.current.smear > 10_000) {
        lastReRaise.current.smear = now
        raise('rotation-smearing')
      }
      if (velocityFeed.capExceeded && now - lastReRaise.current.cap > 10_000) {
        lastReRaise.current.cap = now
        raise('wz-cap-exceeded')
      }
    }, 500)
    return () => {
      clearInterval(t)
      clearInterval(motion)
    }
  }, [prune])

  const alerts = Object.values(active).filter((a) => !a.dismissed)
  if (alerts.length === 0) return null
  return (
    <div className="alert-stack">
      {alerts.map((a) => (
        <div key={a.issue.id}
             className={`alert-banner alert-${a.issue.severity}`}
             title={a.issue.explain}>
          ⚠ {a.issue.title} <em>×{a.count}</em>
          <button onClick={() => dismiss(a.issue.id)}>✕</button>
        </div>
      ))}
    </div>
  )
}
