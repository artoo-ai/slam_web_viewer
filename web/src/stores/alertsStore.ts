import { create } from 'zustand'

/** Known-issue detector: recognized log signatures become explained alarms
 *  instead of scrolling spam. Patterns are matched against every log line;
 *  an active alert shows as a banner until the pattern goes quiet or is
 *  dismissed. Add new signatures here as new failure modes get diagnosed. */

export interface KnownIssue {
  id: string
  re: RegExp
  severity: 'warn' | 'error'
  title: string
  explain: string
}

export const KNOWN_ISSUES: KnownIssue[] = [
  {
    id: 'no-laser-scans',
    re: /Waiting for laser_scans/i,
    severity: 'error',
    title: 'rf2o has no laser scan input',
    explain:
      'Odometry is starving: nothing is publishing /scan. The lidar driver or pointcloud_to_laserscan is down — check start_mid360.sh / start_sensors.sh. The robot cannot localize until this is fixed (the scan cell in the staleness strip should also be red/—).',
  },
  {
    id: 'planner-failed',
    re: /failed to create plan|GridBased.*fail/i,
    severity: 'warn',
    title: 'planner cannot find a path',
    explain:
      'Nav2 could not route to the goal. Usual cause: inflation sealed the corridor or phantom obstacles. Toggle Costmap (global) to see where it pinched shut.',
  },
  {
    id: 'recovery-active',
    re: /spin recovery|back.?up recovery|running recovery|recovery behavior/i,
    severity: 'warn',
    title: 'recovery behaviors running — robot is stuck',
    explain:
      'Nav2 is spinning/backing up to escape. Watch the Rotation tab during spins — recoveries are where map smear historically happened.',
  },
  {
    id: 'tf-timing',
    re: /extrapolation into the future|lookup would require|message filter dropping/i,
    severity: 'warn',
    title: 'TF timing problem',
    explain:
      'Transforms are arriving late or timestamps disagree between nodes — often follows scan gaps (check the staleness strip) or clock skew. Costmap/planner messages get dropped while this persists.',
  },
]

const QUIET_EXPIRE_MS = 45_000

export interface ActiveAlert {
  issue: KnownIssue
  count: number
  firstTs: number
  lastTs: number
  dismissed: boolean
}

interface AlertsState {
  active: Record<string, ActiveAlert>
  ingest: (message: string) => void
  dismiss: (id: string) => void
  prune: () => void
}

export const useAlertsStore = create<AlertsState>((set, get) => ({
  active: {},
  ingest: (message) => {
    for (const issue of KNOWN_ISSUES) {
      if (!issue.re.test(message)) continue
      const now = performance.now()
      const existing = get().active[issue.id]
      if (existing) {
        set({ active: { ...get().active, [issue.id]: { ...existing, count: existing.count + 1, lastTs: now } } })
      } else {
        set({ active: { ...get().active, [issue.id]: { issue, count: 1, firstTs: now, lastTs: now, dismissed: false } } })
        if (issue.severity === 'error') {
          void import('../lib/tts/ttsManager').then((m) => m.speakAlert(`Warning. ${issue.title}.`))
        }
      }
    }
  },
  dismiss: (id) => {
    const existing = get().active[id]
    if (existing) set({ active: { ...get().active, [id]: { ...existing, dismissed: true } } })
  },
  prune: () => {
    const now = performance.now()
    const next = Object.fromEntries(
      Object.entries(get().active).filter(([, a]) => now - a.lastTs < QUIET_EXPIRE_MS),
    )
    if (Object.keys(next).length !== Object.keys(get().active).length) set({ active: next })
  },
}))
