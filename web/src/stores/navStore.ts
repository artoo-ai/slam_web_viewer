import { create } from 'zustand'
import { connection, setNavStatusSink } from '../lib/transport/connection'
import type { GoalAck, NavStatusPayload } from '../types/channels'

/** Nav state machine, fed by goal_acks and the nav_status channel.
 *  `goal` holds the marker position while a goal is pending/active;
 *  terminal states clear the marker but keep `status` for the panel. */

export interface ActiveGoal {
  x: number
  y: number
  theta: number
  goalId: string | null // null until the ack arrives
  sending: boolean
}

interface NavStateStore {
  goal: ActiveGoal | null
  status: NavStatusPayload | null
  sendGoal: (x: number, y: number, theta: number) => void
  cancelGoal: () => void
  onStatus: (status: NavStatusPayload) => void
}

const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'aborted', 'canceled', 'rejected'])

export const useNavStore = create<NavStateStore>((set, get) => ({
  goal: null,
  status: null,

  sendGoal: (x, y, theta) => {
    set({ goal: { x, y, theta, goalId: null, sending: true }, status: null })
    void connection
      .sendCommand({ cmd: 'send_goal', x, y, theta, frame: 'map' })
      .then((ack) => {
        const a = ack as GoalAck | null
        if (!a || a.cmd !== 'goal_ack' || !a.accepted) {
          set({
            goal: null,
            status: { state: 'rejected', message: a?.message ?? 'no response from bridge' },
          })
          return
        }
        const current = get().goal
        if (current?.sending) set({ goal: { ...current, goalId: a.goal_id, sending: false } })
      })
  },

  cancelGoal: () => {
    const goalId = get().goal?.goalId
    void connection.sendCommand({ cmd: 'cancel_goal', ...(goalId ? { goal_id: goalId } : {}) })
    // the canceled nav_status frame clears the marker
  },

  onStatus: (status) => {
    const goal = get().goal
    // ignore stale frames from a previous goal once a new one is pending
    if (goal?.goalId && status.goal_id && status.goal_id !== goal.goalId) return
    set({ status, goal: TERMINAL.has(status.state) ? null : goal })
  },
}))

setNavStatusSink((status) => useNavStore.getState().onStatus(status))
