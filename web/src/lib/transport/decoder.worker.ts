/** Decoder worker: msgpack decode off the main thread.
 *  Receives raw ArrayBuffers, posts DecodedFrame objects; scan point buffers
 *  are copied once (alignment) and transferred (zero-copy handoff). */

import { decode } from '@msgpack/msgpack'
import { CH, toAlignedFloat32 } from './protocol'
import type { DecodedFrame } from '../../types/channels'

interface WireFrame {
  topic: string
  ts: number
  seq: number
  data: unknown
}

self.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  let frame: WireFrame
  try {
    frame = decode(new Uint8Array(e.data)) as WireFrame
  } catch {
    return // malformed frame — drop silently, seq gaps surface in the UI
  }
  if (typeof frame?.topic !== 'string') return

  const binStride =
    frame.topic === CH.SCAN || frame.topic === CH.MAP || frame.topic === CH.SCAN_LOW
      ? 16 // [x,y,z,intensity]
      : frame.topic === CH.DEPTH
        ? 24 // [x,y,z,r,g,b]
        : 0
  if (binStride > 0) {
    const view = frame.data as Uint8Array
    if (!(view instanceof Uint8Array) || view.byteLength % binStride !== 0) return
    const points = toAlignedFloat32(view)
    const msg: DecodedFrame = { topic: frame.topic, ts: frame.ts, seq: frame.seq, points }
    self.postMessage(msg, { transfer: [points.buffer] })
  } else {
    const msg: DecodedFrame = {
      topic: frame.topic,
      ts: frame.ts,
      seq: frame.seq,
      data: frame.data,
    }
    self.postMessage(msg)
  }
}
