import { useDiagnosticsStore } from '../../stores/diagnosticsStore'
import { CH } from '../../lib/transport/protocol'
import { PanelShell } from './PanelShell'
import { DiagHealth } from './DiagHealth'
import { OdomDiagBody } from './OdomDiagBody'

/** FAST-LIO2 — lidar-inertial odometry (the 3D stack's /Odometry source). A
 *  steady high rate is the LIO health signal; sudden jumps mean it diverged. */
export function FastLioPanel() {
  const slot = useDiagnosticsStore((s) => s.fastlio)
  return (
    <PanelShell title="fast-lio2 — lidar-inertial odometry">
      <DiagHealth
        channel={CH.FASTLIO_DIAG}
        ts={slot.ts}
        inactiveHint="FAST-LIO2 runs in the 3D stack. Start ./start_bridge.sh 3d to see it." />
      <OdomDiagBody data={slot.data} deadHz={5} />
    </PanelShell>
  )
}
