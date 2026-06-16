import { useDiagnosticsStore } from '../../stores/diagnosticsStore'
import { CH } from '../../lib/transport/protocol'
import { PanelShell } from './PanelShell'
import { DiagHealth } from './DiagHealth'
import { OdomDiagBody } from './OdomDiagBody'

/** rf2o — Range Flow-based 2D laser odometry (the 2D stack's /odom source).
 *  Detailed cmd-vs-odom rotation tracking lives in the Motion tab; this tab is
 *  the at-a-glance odometry health for the rf2o stage. */
export function Rf2oPanel() {
  const slot = useDiagnosticsStore((s) => s.rf2o)
  return (
    <PanelShell title="rf2o — 2D laser odometry">
      <DiagHealth
        channel={CH.RF2O_DIAG}
        ts={slot.ts}
        inactiveHint="rf2o runs in the 2D stack. Start ./start_bridge.sh 2d to see it." />
      <OdomDiagBody data={slot.data} deadHz={1} />
    </PanelShell>
  )
}
