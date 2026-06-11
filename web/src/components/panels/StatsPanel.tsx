import { useTelemetryStore } from '../../stores/telemetryStore'
import { PanelShell } from './PanelShell'

export function StatsPanel() {
  const stats = useTelemetryStore((s) => s.stats)
  return (
    <PanelShell title="Map Stats">
      {stats ? (
        <dl className="stats-grid">
          <dt>keyframes</dt>
          <dd>{stats.keyframes}</dd>
          <dt>total points</dt>
          <dd>{stats.total_pts.toLocaleString()}</dd>
          <dt>distance</dt>
          <dd>{stats.distance_m.toFixed(1)} m</dd>
          <dt>duration</dt>
          <dd>{stats.duration_s.toFixed(0)} s</dd>
          <dt>scan rate</dt>
          <dd>{stats.scan_hz.toFixed(1)} Hz</dd>
          <dt>health</dt>
          <dd>{(stats.health * 100).toFixed(0)} %</dd>
        </dl>
      ) : (
        <span style={{ color: 'var(--text-dim)' }}>waiting for data…</span>
      )}
    </PanelShell>
  )
}
