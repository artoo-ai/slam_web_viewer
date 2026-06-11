import { create } from 'zustand'
import { connection } from '../lib/transport/connection'

/** Bridge-side .rec recording state, driven by rec_start/rec_stop acks. */

interface RecAck {
  cmd: 'rec_ack'
  id: number
  recording: boolean
  path: string | null
}

interface RecState {
  recording: boolean
  path: string | null
  busy: boolean
  start: () => void
  stop: () => void
}

export const useRecStore = create<RecState>((set) => ({
  recording: false,
  path: null,
  busy: false,
  start: () => {
    set({ busy: true })
    void connection.sendCommand({ cmd: 'rec_start' }).then((ack) => {
      const a = ack as RecAck | null
      set({ busy: false, recording: a?.recording ?? false, path: a?.path ?? null })
    })
  },
  stop: () => {
    set({ busy: true })
    void connection.sendCommand({ cmd: 'rec_stop' }).then((ack) => {
      const a = ack as RecAck | null
      set({ busy: false, recording: false, path: a?.path ?? null })
    })
  },
}))
