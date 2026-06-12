/** WebSocket connection singleton. Created at module scope (survives StrictMode
 *  double-mount); components only subscribe/unsubscribe.
 *
 *  Raw binary frames go straight to the decoder worker (transferred, zero
 *  main-thread decode). Decoded frames are demuxed to per-topic listeners.
 *  High-rate channels (scan, pose) additionally feed the non-reactive
 *  scanFeed/poseFeed; low-rate channels update Zustand stores. */

import { CH, encodeCommand, type Command, type CommandInput } from './protocol'
import { useConnectionStore } from '../../stores/connectionStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { scanFeed } from '../../stores/scanFeed'
import { scanLowFeed } from '../../stores/scanLowFeed'
import { poseFeed } from '../../stores/poseFeed'
import { gridFeed } from '../../stores/gridFeed'
import { pathFeed } from '../../stores/pathFeed'
import { velocityFeed } from '../../stores/velocityFeed'
import { imuFeed } from '../../stores/imuFeed'
import { mapFeed } from '../../stores/mapFeed'
import { useObjectsStore } from '../../stores/objectsStore'
import { useMissionStore, type MissionPayload } from '../../stores/missionStore'
import { useParamsAudit } from '../../stores/paramsAuditStore'
import { stalenessFeed } from '../../stores/stalenessFeed'
import type {
  CmdAckPayload,
  DecodedFrame,
  HelloPayload,
  ImuPayload,
  LogPayload,
  NavPathPayload,
  NavStatusPayload,
  OccupancyGridPayload,
  PosePayload,
  StatsPayload,
  StatusPayload,
  VelocityPayload,
} from '../../types/channels'

type Listener = (frame: DecodedFrame) => void
type ObjectsSetter = ReturnType<typeof useObjectsStore.getState>['setObjects']
type ParamsApplier = ReturnType<typeof useParamsAudit.getState>['apply']

// navStore registers here at import time (it imports this module, so this
// module cannot import it back without a cycle)
let navStatusSink: (status: NavStatusPayload) => void = () => {}
export function setNavStatusSink(sink: (status: NavStatusPayload) => void) {
  navStatusSink = sink
}

const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 5000
const PING_INTERVAL_MS = 2000

function resolveUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('ws')
  if (fromQuery) return fromQuery
  const fromEnv = import.meta.env.VITE_BRIDGE_URL as string | undefined
  if (fromEnv) return fromEnv
  return 'ws://localhost:9090'
}

class Connection {
  private ws: WebSocket | null = null
  private worker: Worker
  private listeners = new Map<string, Set<Listener>>()
  private backoffMs = BACKOFF_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private nextCmdId = 1
  private pendingAcks = new Map<number, (ack: CmdAckPayload) => void>()
  private lastSeq = new Map<string, number>()
  readonly url: string

  constructor() {
    this.url = resolveUrl()
    this.worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker.onmessage = (e: MessageEvent<DecodedFrame>) => this.onFrame(e.data)
    this.connect()
  }

  private connect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    useConnectionStore.getState().setStatus('connecting')
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.backoffMs = BACKOFF_MIN_MS
      this.lastSeq.clear()
      useConnectionStore.getState().setStatus('open')
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS)
    }
    ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      this.worker.postMessage(e.data, [e.data])
    }
    ws.onclose = () => this.onClose()
    ws.onerror = () => ws.close()
  }

  private onClose() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    this.ws = null
    this.pendingAcks.clear()
    useConnectionStore.getState().setStatus('closed')
    const jitter = Math.random() * 0.3 + 0.85 // 0.85x..1.15x
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs * jitter)
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
  }

  private onFrame(frame: DecodedFrame) {
    this.trackSeq(frame)
    if (frame.topic === CH.OCCUPANCY_GRID) {
      const layer = (frame.data as OccupancyGridPayload).layer ?? 'map'
      stalenessFeed.record(`occupancy_grid:${layer}`)
    } else {
      stalenessFeed.record(frame.topic)
    }
    switch (frame.topic) {
      case CH.SCAN:
        if (frame.points) scanFeed.push(frame.points, frame.seq, frame.ts)
        break
      case CH.MAP:
        if (frame.points) mapFeed.push(frame.points)
        break
      case CH.SCAN_LOW:
        if (frame.points) scanLowFeed.push(frame.points, frame.seq)
        break
      case CH.OBJECTS: {
        const data = frame.data as { objects: Parameters<ObjectsSetter>[0] }
        useObjectsStore.getState().setObjects(data.objects)
        break
      }
      case CH.MISSION:
        useMissionStore.getState().setMission(frame.ts, frame.data as MissionPayload)
        break
      case 'node_params':
        useParamsAudit.getState().apply(frame.data as Parameters<ParamsApplier>[0])
        break
      case CH.POSE:
        poseFeed.push(frame.data as PosePayload)
        break
      case CH.OCCUPANCY_GRID:
        gridFeed.push(frame.data as OccupancyGridPayload)
        break
      case CH.NAV_STATUS:
        navStatusSink(frame.data as NavStatusPayload)
        break
      case CH.NAV_PATH:
        pathFeed.push(frame.data as NavPathPayload)
        break
      case CH.VELOCITY:
        velocityFeed.push(frame.data as VelocityPayload, frame.ts)
        break
      case CH.IMU:
        imuFeed.push(frame.data as ImuPayload, frame.ts)
        break
      case CH.HELLO:
        useConnectionStore.getState().setHello(frame.data as HelloPayload)
        break
      case CH.STATS:
        useTelemetryStore.getState().setStats(frame.data as StatsPayload)
        break
      case CH.LOG:
        useTelemetryStore.getState().addLog(frame.ts, frame.data as LogPayload)
        break
      case CH.STATUS: {
        const status = frame.data as StatusPayload
        if (status.event === 'map_reset') mapFeed.clear() // SLAM corrected the frame
        useTelemetryStore.getState().setStatusEvent(frame.ts, status)
        break
      }
      case CH.CMD_ACK: {
        const ack = frame.data as CmdAckPayload
        const resolve = this.pendingAcks.get(ack.id)
        if (resolve) {
          this.pendingAcks.delete(ack.id)
          resolve(ack)
        }
        break
      }
      // unknown topics: ignored per protocol, still fan out to listeners below
    }
    const set = this.listeners.get(frame.topic)
    if (set) for (const cb of set) cb(frame)
  }

  private trackSeq(frame: DecodedFrame) {
    const prev = this.lastSeq.get(frame.topic)
    if (prev !== undefined) {
      const gap = frame.seq - prev - 1
      if (gap > 0) useConnectionStore.getState().addDrops(gap)
    }
    this.lastSeq.set(frame.topic, frame.seq)
  }

  private ping() {
    const t = performance.now()
    void this.sendCommand({ cmd: 'ping', t }).then((ack) => {
      if (ack && 't' in ack) {
        useConnectionStore.getState().setLatency(Math.round(performance.now() - ack.t))
      }
    })
  }

  /** Subscribe to a channel by topic. Returns an unsubscribe function. */
  subscribe(topic: string, cb: Listener): () => void {
    let set = this.listeners.get(topic)
    if (!set) {
      set = new Set()
      this.listeners.set(topic, set)
    }
    set.add(cb)
    return () => set.delete(cb)
  }

  /** Send a command; resolves with its cmd_ack (or null if not connected /
   *  timed out). Slow commands (map_save compresses on the robot) get longer. */
  sendCommand(command: CommandInput, timeoutMs = 5000): Promise<CmdAckPayload | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(null)
    const id = this.nextCmdId++
    const bytes = encodeCommand({ ...command, id } as Command)
    this.ws.send(bytes)
    return new Promise((resolve) => {
      this.pendingAcks.set(id, resolve)
      setTimeout(() => {
        if (this.pendingAcks.delete(id)) resolve(null)
      }, timeoutMs)
    })
  }
}

export const connection = new Connection()
