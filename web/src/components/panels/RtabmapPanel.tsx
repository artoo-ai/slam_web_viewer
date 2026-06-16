import { useDiagnosticsStore } from '../../stores/diagnosticsStore'
import { CH } from '../../lib/transport/protocol'
import { PanelShell } from './PanelShell'
import { DiagHealth, DiagRow } from './DiagHealth'
import { fmtNum } from './diagFormat'

/** RTAB-Map — 3D graph SLAM. Loop closures, processing time, and working-memory
 *  size from /rtabmap/info. */
export function RtabmapPanel() {
  const slot = useDiagnosticsStore((s) => s.rtabmap)
  const d = slot.data
  return (
    <PanelShell title="rtabmap — 3D graph SLAM">
      <DiagHealth
        channel={CH.RTABMAP_DIAG}
        ts={slot.ts}
        inactiveHint="RTAB-Map runs in the 3D stack (needs rtabmap_msgs). Start ./start_bridge.sh 3d to see it." />
      {!d ? (
        <div className="diag-empty">waiting for /rtabmap/info…</div>
      ) : (
        <div className="diag-body">
          <DiagRow
            k="loop closures"
            tip="Cumulative loop closures — the global corrections that snap the map back together. More is good (the map is consistent).">
            {d.loop_total}
            {d.loop_last_id ? ` (last id ${d.loop_last_id})` : ''}
          </DiagRow>
          <DiagRow k="proximity" tip="Cumulative proximity detections (local re-localizations).">
            {d.proximity}
          </DiagRow>
          <DiagRow k="current node" tip="Current map node id (refId).">{d.ref_id}</DiagRow>
          <DiagRow
            k="processing"
            warn={d.proc_ms !== null && d.proc_ms > 200}
            tip="Per-update processing time. Approaching the sensor period (e.g. 100 ms at 10 Hz) means RTAB-Map is falling behind.">
            {d.proc_ms === null ? '—' : fmtNum(d.proc_ms, 1, 'ms')}
          </DiagRow>
          <DiagRow k="working memory" tip="Nodes held in working memory.">
            {d.wm_size ?? '—'}
          </DiagRow>
          <DiagRow k="words" tip="Visual words in the current frame.">
            {d.words ?? '—'}
          </DiagRow>
          <DiagRow
            k="localized"
            tip="Whether a recent localization pose was seen (localization mode), vs pure mapping.">
            {d.localized === null ? '—' : d.localized ? 'yes' : 'no'}
          </DiagRow>
        </div>
      )}
    </PanelShell>
  )
}
