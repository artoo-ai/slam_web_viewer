import { useEffect, useState } from 'react'
import { useViewerParams } from '../../stores/viewerParamsStore'
import { useLayersStore } from '../../stores/layersStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { mapFeed } from '../../stores/mapFeed'
import { connection } from '../../lib/transport/connection'
import { useMjpeg } from '../../lib/mjpeg'
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
 *  floating windows. Streams come from hello.cameras (1-4). The MJPEG reader
 *  (fetch-based, with stall detection + reconnect) lives in lib/mjpeg.ts and is
 *  shared with the VR camera panel. */

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
