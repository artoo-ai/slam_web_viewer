import { useEffect, useState } from 'react'
import { useViewerParams } from '../../stores/viewerParamsStore'
import { useLayersStore } from '../../stores/layersStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { mapFeed } from '../../stores/mapFeed'
import { connection } from '../../lib/transport/connection'
import './chrome.css'

/** Right-edge intensity legend — gradient matches the point shader's ramp. */
export function IntensityLegend() {
  const colorMode = useViewerParams((s) => s.colorMode)
  const heightMin = useViewerParams((s) => s.heightMin)
  const heightMax = useViewerParams((s) => s.heightMax)
  const labels =
    colorMode === 'intensity'
      ? ['1.00', '0.75', '0.50', '0.25', '0.00']
      : [heightMax.toFixed(1), '', ((heightMax + heightMin) / 2).toFixed(1), '', heightMin.toFixed(1)]
  return (
    <div className="legend">
      <div className="legend-title">{colorMode === 'intensity' ? 'Intensity' : 'Height m'}</div>
      <div className="legend-body">
        <div className="legend-bar" />
        <div className="legend-labels">
          {labels.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Bottom-right bbox readout, SJY-style. */
export function BboxReadout() {
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const bbox = mapFeed.bbox
  return (
    <div className="bbox">
      <div>
        Map: {mapFeed.count.toLocaleString()} pts
        {mapFeed.isFull && <span className="bbox-full"> (cap reached)</span>}
      </div>
      {bbox && (
        <>
          <div>X: {bbox.min[0].toFixed(1)} → {bbox.max[0].toFixed(1)} / {(bbox.max[0] - bbox.min[0]).toFixed(1)}m</div>
          <div>Y: {bbox.min[1].toFixed(1)} → {bbox.max[1].toFixed(1)} / {(bbox.max[1] - bbox.min[1]).toFixed(1)}m</div>
          <div>Z: {bbox.min[2].toFixed(1)} → {bbox.max[2].toFixed(1)} / {(bbox.max[2] - bbox.min[2]).toFixed(1)}m</div>
        </>
      )}
    </div>
  )
}

/** Camera dock: SJY-style strip flush against the bottom-right edge — never
 *  floating windows. Streams come from hello.cameras (1-4). The MJPEG stream
 *  is consumed via fetch() rather than <img src>: a plain img freezes on the
 *  last frame forever when the TCP stream dies (flaky robot WiFi) with no
 *  error event — reading it ourselves gives stall detection + reconnect. */

const SOI = [0xff, 0xd8] // JPEG start marker
const EOI = [0xff, 0xd9] // JPEG end marker

function findMarker(buf: Uint8Array, marker: number[], from: number): number {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === marker[0] && buf[i + 1] === marker[1]) return i
  }
  return -1
}

function useMjpeg(url: string) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [ageS, setAgeS] = useState(Infinity)

  useEffect(() => {
    let stop = false
    let lastFrame = 0
    let currentUrl: string | null = null
    const controller = new AbortController()

    const ageTimer = setInterval(
      () => setAgeS(lastFrame ? (performance.now() - lastFrame) / 1000 : Infinity),
      1000,
    )

    const run = async () => {
      while (!stop) {
        try {
          const res = await fetch(url, { signal: controller.signal })
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
          /* connection refused / dropped — fall through to retry */
        }
        if (!stop) await new Promise((r) => setTimeout(r, 2000))
      }
    }
    void run()
    return () => {
      stop = true
      controller.abort()
      clearInterval(ageTimer)
      if (currentUrl) URL.revokeObjectURL(currentUrl)
    }
  }, [url])

  return { frameUrl, ageS }
}

function CamSlot({ url, name }: { url: string; name: string }) {
  const { frameUrl, ageS } = useMjpeg(url)
  const [big, setBig] = useState(false)
  const stalled = ageS > 3
  return (
    <div className={`cam-slot ${big ? 'cam-slot-big' : ''}`}
         onClick={() => setBig((b) => !b)}
         title={`camera "${name}" — ${url}\nclick to ${big ? 'shrink' : 'enlarge'}`}>
      {frameUrl && <img src={frameUrl} alt={name} />}
      <span className="cam-slot-label">
        {name}
        {stalled && <em> · {frameUrl ? `stalled ${ageS < 999 ? ageS.toFixed(0) + 's' : ''} — reconnecting` : 'no stream'}</em>}
      </span>
    </div>
  )
}

export function CameraInset() {
  const visible = useLayersStore((s) => s.camera)
  const status = useConnectionStore((s) => s.status)
  const cameras = useConnectionStore((s) => s.hello?.cameras)
  if (!visible || status !== 'open') return null
  const fromQuery = new URLSearchParams(window.location.search).get('cam')
  const host = new URL(connection.url.replace(/^ws/, 'http')).hostname
  const names = (cameras?.length ? cameras : ['rgb']).slice(0, 4)
  const placeholders = Math.max(0, 2 - names.length) // SJY look: keep ≥2 slots
  return (
    <div className="cam-dock">
      {names.map((name) => (
        <CamSlot key={name}
                 url={fromQuery && names.length === 1 ? fromQuery : `http://${host}:8080/stream/${name}`}
                 name={name} />
      ))}
      {Array.from({ length: placeholders }, (_, i) => (
        <div key={`empty-${i}`} className="cam-slot cam-slot-empty" />
      ))}
    </div>
  )
}
