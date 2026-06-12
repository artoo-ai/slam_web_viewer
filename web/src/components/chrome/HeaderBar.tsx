import { useEffect, useState } from 'react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useRecStore } from '../../stores/recStore'
import { useParamsAudit } from '../../stores/paramsAuditStore'
import { connection } from '../../lib/transport/connection'
import { fpsMeter } from '../../lib/viewportRefs'
import { mapFeed } from '../../stores/mapFeed'
import { scanFeed } from '../../stores/scanFeed'
import './chrome.css'

/** SJY-style header: wordmark | Points: N | FPS — center | REC, connection,
 *  latency, quality chip — right. */

function qualityFromHealth(health: number | undefined): { label: string; cls: string } {
  if (health === undefined) return { label: '—', cls: 'idle' }
  if (health >= 0.9) return { label: `Good (${health.toFixed(2)})`, cls: 'good' }
  if (health >= 0.7) return { label: `Fair (${health.toFixed(2)})`, cls: 'fair' }
  return { label: `Poor (${health.toFixed(2)})`, cls: 'poor' }
}

export function HeaderBar() {
  const status = useConnectionStore((s) => s.status)
  const latencyMs = useConnectionStore((s) => s.latencyMs)
  const drops = useConnectionStore((s) => s.drops)
  const hello = useConnectionStore((s) => s.hello)
  const health = useTelemetryStore((s) => s.stats?.health)
  const recording = useRecStore((s) => s.recording)
  const cfgMismatches = useParamsAudit((s) => s.mismatches)
  const cfgUnknowns = useParamsAudit((s) => s.unknowns)
  const cfgRows = useParamsAudit((s) => s.rows.length)
  const [scene, setScene] = useState({ pts: 0, fps: 0 })

  useEffect(() => {
    const t = setInterval(
      () => setScene({ pts: mapFeed.count + scanFeed.count, fps: fpsMeter.fps }),
      500,
    )
    return () => clearInterval(t)
  }, [])

  const quality = qualityFromHealth(health)
  return (
    <header className="hdr">
      <span className="hdr-wordmark">Robot GUI</span>
      <span className="hdr-points"
            title="Points currently in the 3D scene (accumulated map + live scan) and browser render rate. FPS dropping as the map grows = approaching this machine's GPU limit.">
        Points: {scene.pts.toLocaleString()} | {scene.fps} FPS
      </span>
      <span className="hdr-spacer" />
      {recording && <span className="hdr-rec">● REC</span>}
      <span className={`hdr-conn hdr-conn-${status}`}>
        <span className="status-dot-sm" />
        {status === 'open' ? `${hello?.server ?? '?'} @ ${connection.url.replace('ws://', '')}` : status}
      </span>
      <span className="hdr-stat">{status === 'open' && latencyMs !== null ? `${latencyMs} ms` : '—'}</span>
      <span className="hdr-stat">{drops} drop</span>
      {cfgRows > 0 && (
        <span
          className={`hdr-quality hdr-quality-${cfgMismatches ? 'poor' : cfgUnknowns ? 'fair' : 'good'}`}
          title="Deployed-config audit (Config tab): live parameter values on the robot vs the expected manifest. Red = stale build — what burned three debugging sessions.">
          {cfgMismatches ? `CONFIG ✗ ${cfgMismatches}` : cfgUnknowns ? 'CONFIG ?' : 'CONFIG ✓'}
        </span>
      )}
      <span className={`hdr-quality hdr-quality-${quality.cls}`}
            title="Single-glance SLAM health score from the backend (0–1). The one number to watch during a run.">
        {quality.label}
      </span>
    </header>
  )
}
