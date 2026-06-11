import { useNavStore } from '../../stores/navStore'
import { PanelShell } from './PanelShell'
import type { NavState } from '../../types/channels'

const STATE_COLORS: Record<NavState, string> = {
  accepted: 'var(--accent)',
  navigating: 'var(--accent)',
  succeeded: 'var(--ok)',
  aborted: 'var(--err)',
  canceled: 'var(--warn)',
  rejected: 'var(--err)',
}

export function NavPanel() {
  const goal = useNavStore((s) => s.goal)
  const status = useNavStore((s) => s.status)
  const cancelGoal = useNavStore((s) => s.cancelGoal)
  const active = goal !== null

  return (
    <PanelShell title="Navigation">
      <div className="nav-panel">
        {status ? (
          <div className="nav-status">
            <span style={{ color: STATE_COLORS[status.state] }}>{status.state}</span>
            {status.goal_id && <span className="nav-dim"> {status.goal_id}</span>}
            {status.distance_m !== undefined && <span> · {status.distance_m.toFixed(1)} m</span>}
            {status.eta_s !== undefined && <span> · eta {status.eta_s.toFixed(0)} s</span>}
            {status.message && <div className="nav-dim">{status.message}</div>}
          </div>
        ) : (
          <div className="nav-dim">
            {active ? 'sending goal…' : 'double-click the map to send a goal'}
          </div>
        )}
        {active && (
          <button className="nav-cancel" onClick={cancelGoal}>
            Cancel goal
          </button>
        )}
      </div>
    </PanelShell>
  )
}
