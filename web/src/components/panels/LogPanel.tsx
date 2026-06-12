import { useEffect, useRef } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { PanelShell } from './PanelShell'

export function LogPanel() {
  const logs = useTelemetryStore((s) => s.logs)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <PanelShell title="Log">
      <ul className="log-list" ref={listRef}>
        {logs.map((entry) => (
          <li key={entry.key} className={`log-level-${entry.level}`}>
            {new Date(entry.ts * 1000).toLocaleTimeString()} {entry.message}
            {entry.repeats > 1 && <b className="log-repeat"> ×{entry.repeats}</b>}
          </li>
        ))}
      </ul>
    </PanelShell>
  )
}
