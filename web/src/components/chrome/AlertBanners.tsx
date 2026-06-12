import { useEffect } from 'react'
import { useAlertsStore } from '../../stores/alertsStore'
import './chrome.css'

/** Known-issue banners, top-center under the staleness strip. Each names the
 *  problem in plain language; hover for the explanation + what to check. */
export function AlertBanners() {
  const active = useAlertsStore((s) => s.active)
  const dismiss = useAlertsStore((s) => s.dismiss)
  const prune = useAlertsStore((s) => s.prune)

  useEffect(() => {
    const t = setInterval(prune, 5000)
    return () => clearInterval(t)
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
