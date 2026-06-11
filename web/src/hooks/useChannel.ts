import { useEffect, useRef } from 'react'
import { connection } from '../lib/transport/connection'
import type { DecodedFrame } from '../types/channels'

/** Subscribe to a WebSocket channel by topic. The callback is kept in a ref so
 *  changing it does not resubscribe. */
export function useChannel(topic: string, cb: (frame: DecodedFrame) => void) {
  const cbRef = useRef(cb)
  cbRef.current = cb
  useEffect(() => connection.subscribe(topic, (frame) => cbRef.current(frame)), [topic])
}
