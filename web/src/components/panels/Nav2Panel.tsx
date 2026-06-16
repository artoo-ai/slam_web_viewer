import { useDiagnosticsStore } from '../../stores/diagnosticsStore'
import { CH } from '../../lib/transport/protocol'
import { PanelShell } from './PanelShell'
import { DiagHealth, DiagRow } from './DiagHealth'
import { fmtNum } from './diagFormat'

/** Nav2 — navigation. Composed state, active behavior-tree leaf, recovery
 *  count, current plan length, and the latest controller command. Nav2 can run
 *  under either stack, so this tab is "stale" (not "inactive") when Nav2 is
 *  down rather than out-of-stack. */
export function Nav2Panel() {
  const slot = useDiagnosticsStore((s) => s.nav2)
  const d = slot.data
  const recovering =
    !!d && (d.bt_node ? /Spin|BackUp|Wait|Clear|Recovery|DriveOnHeading/.test(d.bt_node) : false)
  return (
    <PanelShell title="nav2 — navigation">
      <DiagHealth
        channel={CH.NAV2_DIAG}
        ts={slot.ts}
        inactiveHint="Nav2 is not publishing — bring up the navigation stack." />
      {!d ? (
        <div className="diag-empty">waiting for nav2…</div>
      ) : (
        <div className="diag-body">
          <DiagRow k="state" tip="Composed navigation state.">{d.state}</DiagRow>
          <DiagRow
            k="BT node"
            warn={recovering}
            tip="The behavior-tree leaf currently ticking. A recovery name here (Spin, BackUp, Wait, Clear*) means Nav2 is recovering, not driving the plan. Needs nav2_msgs/BehaviorTreeLog.">
            {d.bt_node ?? '— (no BT log)'}
          </DiagRow>
          <DiagRow
            k="recoveries"
            warn={d.recoveries.total > 0}
            tip="Cumulative recovery actions this session. Climbing during a run = the robot keeps getting stuck.">
            {d.recoveries.total}
            {d.recoveries.last ? ` (last: ${d.recoveries.last})` : ''}
          </DiagRow>
          <DiagRow
            k="plan poses"
            warn={d.state === 'navigating' && d.plan_poses === 0}
            tip="Length of the current global plan. 0 while navigating = the planner produced no path (check the costmap for a sealed passage).">
            {d.plan_poses}
          </DiagRow>
          <DiagRow k="controller cmd" tip="Latest commanded body velocity from the controller.">
            {fmtNum(d.cmd.vx, 2)} m/s · {fmtNum(d.cmd.wz, 2)} rad/s
          </DiagRow>
          {d.servers && (
            <DiagRow
              k="servers"
              warn={!d.servers.planner || !d.servers.controller}
              tip="Planner / controller server liveness.">
              planner {d.servers.planner ? 'up' : 'down'} · controller{' '}
              {d.servers.controller ? 'up' : 'down'}
            </DiagRow>
          )}
        </div>
      )}
    </PanelShell>
  )
}
