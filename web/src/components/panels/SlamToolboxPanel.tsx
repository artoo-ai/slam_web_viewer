import { useDiagnosticsStore } from '../../stores/diagnosticsStore'
import { CH } from '../../lib/transport/protocol'
import { PanelShell } from './PanelShell'
import { DiagHealth, DiagRow } from './DiagHealth'
import { fmtNum } from './diagFormat'

/** slam_toolbox — 2D graph SLAM. Map coverage, pose-graph growth, and how much
 *  map→odom is correcting odometry drift right now. */
export function SlamToolboxPanel() {
  const slot = useDiagnosticsStore((s) => s.slamToolbox)
  const d = slot.data
  return (
    <PanelShell title="slam_toolbox — 2D graph SLAM">
      <DiagHealth
        channel={CH.SLAM_TOOLBOX_DIAG}
        ts={slot.ts}
        inactiveHint="slam_toolbox runs in the 2D stack. Start ./start_bridge.sh 2d to see it." />
      {!d ? (
        <div className="diag-empty">waiting for slam_toolbox…</div>
      ) : (
        <div className="diag-body">
          <div className="diag-sub">map</div>
          {d.map ? (
            <>
              <DiagRow k="size" tip="Occupancy grid dimensions and resolution.">
                {d.map.w}×{d.map.h} @ {fmtNum(d.map.res, 3, 'm')}
              </DiagRow>
              <DiagRow k="known area" tip="Mapped (non-unknown) area.">
                {fmtNum(d.map.known_m2, 1, 'm²')}
              </DiagRow>
              <DiagRow
                k="updates"
                warn={d.map.update_hz === 0}
                tip="Total map updates and the current update rate. 0 Hz while moving = SLAM stalled.">
                {d.map.updates} ({fmtNum(d.map.update_hz, 1, 'Hz')})
              </DiagRow>
            </>
          ) : (
            <DiagRow k="map" tip="No map received yet.">—</DiagRow>
          )}

          <div className="diag-sub">pose-graph</div>
          {d.graph ? (
            <DiagRow
              k="nodes / edges"
              tip="Pose-graph vertices and constraints. Should grow while exploring; a flat count means no new keyframes are being added.">
              {d.graph.nodes} / {d.graph.edges ?? '—'}
            </DiagRow>
          ) : (
            <DiagRow
              k="nodes / edges"
              tip="The graph_visualization marker array hasn't been seen yet.">
              — (no graph viz)
            </DiagRow>
          )}

          <div className="diag-sub">map → odom correction</div>
          {d.correction ? (
            <DiagRow
              k="last shift"
              warn={d.correction.dist_m > 0.15 || d.correction.yaw_deg > 5}
              tip="How far the map→odom transform jumped on the last tick — the drift SLAM is absorbing. Large, frequent shifts = the scan matcher is fighting bad odometry.">
              {fmtNum(d.correction.dist_m, 3, 'm')} · {fmtNum(d.correction.yaw_deg, 2, '°')}
            </DiagRow>
          ) : (
            <DiagRow k="last shift" tip="map→odom TF not available yet.">—</DiagRow>
          )}
          {d.mode && (
            <DiagRow k="mode" tip="slam_toolbox mode.">{d.mode}</DiagRow>
          )}
        </div>
      )}
    </PanelShell>
  )
}
