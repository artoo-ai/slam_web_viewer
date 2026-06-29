import { useEffect, useState } from 'react'
import { connection } from './transport/connection'

/** Shared MJPEG reader for the bridge's :8080 `/stream/<name>` endpoints.
 *
 *  The stream is consumed via fetch() rather than `<img src>`: a plain img
 *  freezes on the last frame forever when the TCP stream dies (flaky robot
 *  WiFi) with no error event — reading it ourselves gives stall detection +
 *  reconnect. Returns the latest frame as an object URL plus its age in seconds.
 *
 *  Used by the desktop camera dock (`<img>`) and the VR camera panel (texture). */

const SOI = [0xff, 0xd8] // JPEG start marker
const EOI = [0xff, 0xd9] // JPEG end marker

function findMarker(buf: Uint8Array, marker: number[], from: number): number {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === marker[0] && buf[i + 1] === marker[1]) return i
  }
  return -1
}

/** Resolve the stream URL for a camera name. On an HTTPS page (the Quest) a
 *  plain `http://host:8080` stream is blocked as mixed content, so we target the
 *  same-origin `/camera/stream/<name>` path that the Vite dev server proxies to
 *  the robot's :8080. On a plain-http page we hit the robot directly. A `?cam=`
 *  query param overrides everything (single-camera manual override). */
export function cameraStreamUrl(name: string): string {
  const fromQuery = new URLSearchParams(window.location.search).get('cam')
  if (window.location.protocol === 'https:') return `/camera/stream/${name}`
  if (fromQuery) return fromQuery
  const host = new URL(connection.url.replace(/^ws/, 'http')).hostname
  return `http://${host}:8080/stream/${name}`
}

export function useMjpeg(url: string) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [ageS, setAgeS] = useState(Infinity)

  useEffect(() => {
    let stop = false
    let lastFrame = 0
    let currentUrl: string | null = null
    let attempt: AbortController | null = null

    const ageTimer = setInterval(
      () => setAgeS(lastFrame ? (performance.now() - lastFrame) / 1000 : Infinity),
      1000,
    )

    const run = async () => {
      while (!stop) {
        attempt = new AbortController()
        const started = performance.now()
        // true stall watchdog: a connection that stays open but sends nothing
        // (bridge lost its camera) hangs read() forever — force a re-dial
        const watchdog = setInterval(() => {
          if (performance.now() - Math.max(lastFrame, started) > 5000) attempt?.abort()
        }, 1000)
        try {
          const res = await fetch(url, { signal: attempt.signal })
          const reader = res.body?.getReader()
          if (!reader) throw new Error('no body')
          let buf = new Uint8Array(0)
          for (;;) {
            const { value, done } = await reader.read()
            if (done || stop) break
            const merged = new Uint8Array(buf.length + value.length)
            merged.set(buf)
            merged.set(value, buf.length)
            buf = merged
            for (;;) {
              const start = findMarker(buf, SOI, 0)
              if (start < 0) break
              const end = findMarker(buf, EOI, start + 2)
              if (end < 0) break
              const jpeg = buf.slice(start, end + 2)
              buf = buf.slice(end + 2)
              const next = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }))
              if (currentUrl) URL.revokeObjectURL(currentUrl)
              currentUrl = next
              lastFrame = performance.now()
              setFrameUrl(next)
            }
            if (buf.length > 2_000_000) buf = new Uint8Array(0) // corrupt stream guard
          }
        } catch {
          /* connection refused / dropped / watchdog abort — retry */
        } finally {
          clearInterval(watchdog)
        }
        if (!stop) await new Promise((r) => setTimeout(r, 2000))
      }
    }
    void run()
    return () => {
      stop = true
      attempt?.abort()
      clearInterval(ageTimer)
      if (currentUrl) URL.revokeObjectURL(currentUrl)
    }
  }, [url])

  return { frameUrl, ageS }
}
