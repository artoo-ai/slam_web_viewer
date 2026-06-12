import { useState } from 'react'
import { useLayersStore, type LayerVisibility } from '../../stores/layersStore'
import { useViewerParams, type FollowMode } from '../../stores/viewerParamsStore'
import { useBookmarks } from '../../stores/bookmarksStore'
import { useRecStore } from '../../stores/recStore'
import { useSendCommand } from '../../hooks/useSendCommand'
import { connection } from '../../lib/transport/connection'

const connectionSend = connection.sendCommand.bind(connection)
import { takeScreenshot } from '../../lib/viewportRefs'
import { EXPECTED_PARAMS, EXTRA_KNOWN_PARAMS } from '../../config/expectedParams'
import type { ParamAck } from '../../types/channels'

/** node|param presets for the Remote Param dropdown: audit manifest + extras,
 *  grouped by node. value suggestion comes from expect / suggest. */
const PARAM_PRESETS = [
  ...EXPECTED_PARAMS.map((e) => ({
    node: e.node,
    param: e.param,
    suggest: e.expect === null ? '' : Array.isArray(e.expect) ? `[${e.expect.join(', ')}]` : String(e.expect),
    tip: e.tip,
  })),
  ...EXTRA_KNOWN_PARAMS,
]
const PRESET_NODES = [...new Set(PARAM_PRESETS.map((p) => p.node))]
import './chrome.css'

/** SJY-style left sidebar: View Options -> Follow -> Color -> Bookmarks ->
 *  Point Size -> Voice -> Screenshot -> Remote params -> Recording. */

const LAYERS: { key: keyof LayerVisibility; label: string; tip: string }[] = [
  { key: 'scan', label: 'Current Points',
    tip: 'The latest single LiDAR sweep (~1 frame). Shows what the sensor sees RIGHT NOW. If this lags or tears during rotation, odometry is struggling to keep up.' },
  { key: 'scan_low', label: 'Low Obstacles',
    tip: 'The 0.05–0.15 m slice (/scan_low) feeding the costmap’s low_obstacle_layer — dog bowls, shoes, anything below the main scan band. Red dots hugging the floor. If the robot swerves around “nothing”, this layer shows the something.' },
  { key: 'depth_points', label: 'Depth Camera',
    tip: 'True-color point cloud from the depth camera (D435) — the camera’s view in 3D, complementing the LiDAR. Needs pointcloud.enable=true on the camera node (Remote Param: node d435_front/camera).' },
  { key: 'map_points', label: 'Map Points',
    tip: 'Accumulated 3D map: every voxel the LiDAR has ever seen (10 cm dedup). This is SLAM’s long-term memory. Ghost/double walls here mean the odometry drifted or smeared.' },
  { key: 'trajectory', label: 'Trajectory',
    tip: 'The path the robot believes it took (from odometry/SLAM poses). A loop that doesn’t visually close back on itself = accumulated drift.' },
  { key: 'map', label: 'Occupancy Map',
    tip: 'slam_toolbox/RTABMap’s 2D grid: gray = explored free space, bright = walls/obstacles, transparent = unknown. This is what the planner navigates on.' },
  { key: 'costmap_global', label: 'Costmap (global)',
    tip: 'Nav2’s planning costs on top of the map: magenta = lethal, red/yellow/blue gradient = inflation around obstacles. If a corridor is fully colored, the planner cannot pass — the cause of “robot won’t move”.' },
  { key: 'costmap_local', label: 'Costmap (local)',
    tip: 'The rolling 6×6 m costmap built from LIVE scans — what the controller dodges right now. Compare with global: phantom obstacles here but not there = sensor noise, not the map.' },
  { key: 'path', label: 'Planned Path',
    tip: 'Nav2’s current global plan (amber line). Disappears when planning fails — correlate with the costmap to find where it pinched shut.' },
  { key: 'camera', label: 'Camera',
    tip: 'Live RGB feed from the depth camera (MJPEG inset, bottom-right). Ground truth for what the robot is actually looking at.' },
]

export function Sidebar() {
  const layers = useLayersStore()
  const params = useViewerParams()
  const bookmarks = useBookmarks()
  const rec = useRecStore()
  const send = useSendCommand()

  const [bookmarkSel, setBookmarkSel] = useState('')
  const [custom, setCustom] = useState(false)
  const [node, setNode] = useState('slam_toolbox')
  const [pname, setPname] = useState('')
  const [pvalue, setPvalue] = useState('')
  const [ack, setAck] = useState<string | null>(null)
  const [mapSaved, setMapSaved] = useState<string | null>(null)

  const saveMap = async () => {
    setMapSaved('saving…')
    const reply = (await connectionSend({ cmd: 'map_save' }, 30_000)) as
      | { cmd: string; ok: boolean; path?: string; points?: number; bytes?: number; message?: string }
      | null
    if (!reply) setMapSaved('no reply')
    else if (reply.ok && reply.path)
      setMapSaved(`${reply.path} (${((reply.bytes ?? 0) / 1024).toFixed(0)} KiB)`)
    else setMapSaved(reply.message ?? 'failed')
  }

  const sendParam = async () => {
    if (!pname.trim()) return
    const num = Number(pvalue)
    const parsed: unknown =
      pvalue.trim() === 'true' ? true :
      pvalue.trim() === 'false' ? false :
      Number.isFinite(num) && pvalue.trim() !== '' ? num : pvalue
    const reply = (await send({
      cmd: 'set_param', node: node.trim(), params: { [pname.trim()]: parsed },
    })) as (ParamAck & { reasons?: Record<string, string> }) | null
    if (!reply) setAck('timeout')
    else if (Object.keys(reply.accepted ?? {}).length) setAck('accepted')
    else {
      const reason = reply.reasons?.[pname.trim()]
      setAck(reason ? `rejected — ${reason}` : 'rejected')
    }
  }

  return (
    <aside className="sidebar">
      <div className="sb-section">
        <div className="sb-title">View Options</div>
        {LAYERS.map(({ key, label, tip }) => (
          <label key={key} className="sb-check" title={tip}>
            <input type="checkbox" checked={layers[key]} onChange={() => layers.toggle(key)} />
            {label}
          </label>
        ))}
      </div>

      <div className="sb-section">
        <label className="sb-check"
               title="Camera tracks the robot automatically. Chase = behind the robot (driving view); Top-down = overhead (best for watching exploration coverage); Free = orbit/pan yourself.">
          <input
            type="checkbox"
            checked={params.follow !== 'free'}
            onChange={(e) => params.setFollow(e.target.checked ? 'chase' : 'free')}
          />
          Follow Pose
        </label>
        <select
          className="sb-select"
          value={params.follow}
          onChange={(e) => params.setFollow(e.target.value as FollowMode)}
        >
          <option value="free">Free</option>
          <option value="chase">Chase</option>
          <option value="top">Top-down</option>
        </select>
      </div>

      <div className="sb-section">
        <div className="sb-title">Color</div>
        <select
          className="sb-select"
          title="Intensity = LiDAR return strength (material/reflectivity — retroreflectors glow red). Height = color by z — instantly shows what falls inside the 2D scan slice (0.15–0.45 m) vs floor and ceiling."
          value={params.colorMode}
          onChange={(e) => params.setColorMode(e.target.value as 'intensity' | 'height')}
        >
          <option value="intensity">Intensity</option>
          <option value="height">Height (z)</option>
        </select>
        <div className="sb-slider-row"
             title="Brightness curve of the colormap. Lower gamma brightens dim points — useful when most returns are low-intensity (matte surfaces).">
          <span>Gamma</span>
          <input type="range" min={0.3} max={2.2} step={0.1} value={params.gamma}
                 onChange={(e) => params.setGamma(Number(e.target.value))} />
          <span className="sb-val">{params.gamma.toFixed(1)}</span>
        </div>
        <div className="sb-slider-row"
             title="Rendered size of each LiDAR point. Bigger reads better from far away; smaller shows fine structure up close.">
          <span>Point Size</span>
          <input type="range" min={1} max={8} step={0.5} value={params.pointSize}
                 onChange={(e) => params.setPointSize(Number(e.target.value))} />
          <span className="sb-val">{params.pointSize.toFixed(1)}</span>
        </div>
      </div>

      <div className="sb-section">
        <div className="sb-title">Bookmark</div>
        <div className="sb-row">
          <select className="sb-select" value={bookmarkSel}
                  onChange={(e) => { setBookmarkSel(e.target.value); bookmarks.apply(e.target.value) }}>
            <option value="">—</option>
            {bookmarks.bookmarks.map((b) => (
              <option key={b.name} value={b.name}>{b.name}</option>
            ))}
          </select>
          <button className="sb-btn" onClick={() => {
            const name = prompt('Bookmark name?')
            if (name) { bookmarks.save(name); setBookmarkSel(name) }
          }}>Save</button>
          <button className="sb-btn" disabled={!bookmarkSel}
                  onClick={() => { bookmarks.remove(bookmarkSel); setBookmarkSel('') }}>Del</button>
        </div>
      </div>

      <div className="sb-section">
        <label className="sb-check">
          <input type="checkbox" checked={params.voiceAlerts}
                 onChange={(e) => params.setVoiceAlerts(e.target.checked)} />
          Voice alerts
        </label>
        <button className="sb-btn sb-btn-wide" onClick={takeScreenshot}>Screenshot</button>
      </div>

      <div className="sb-section">
        <div className="sb-title">Remote Param</div>
        <select
          className="sb-select"
          title="Known node/parameter combinations (the audited params + useful runtime toggles). Pick one to fill the fields — or Custom to type your own."
          value={custom ? 'custom' : `${node}|${pname}`}
          onChange={(e) => {
            if (e.target.value === 'custom') {
              setCustom(true)
              return
            }
            const preset = PARAM_PRESETS.find((p) => `${p.node}|${p.param}` === e.target.value)
            if (preset) {
              setCustom(false)
              setNode(preset.node)
              setPname(preset.param)
              setPvalue(preset.suggest)
            }
          }}
        >
          <option value="custom">Custom…</option>
          {PRESET_NODES.map((n) => (
            <optgroup key={n} label={n}>
              {PARAM_PRESETS.filter((p) => p.node === n).map((p) => (
                <option key={`${p.node}|${p.param}`} value={`${p.node}|${p.param}`} title={p.tip}>
                  {p.param}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {custom && (
          <>
            <input className="sb-input" placeholder="node" value={node} onChange={(e) => setNode(e.target.value)} />
            <input className="sb-input" placeholder="parameter" value={pname} onChange={(e) => setPname(e.target.value)} />
          </>
        )}
        <input className="sb-input" placeholder="value" value={pvalue} onChange={(e) => setPvalue(e.target.value)} />
        <div className="sb-row">
          <button className="sb-btn" disabled={!pname.trim()} onClick={() => void sendParam()}>Send</button>
          {ack && (
            <span className={`sb-ack sb-ack-${
              ack.startsWith('accepted') ? 'accepted' :
              ack.startsWith('timeout') ? 'timeout' : 'rejected'}`}>
              {ack}
            </span>
          )}
        </div>
      </div>

      <div className="sb-section sb-recording">
        <div className="sb-title"
             title="Record the entire telemetry stream to a .rec file ON THE ROBOT, then replay it later at any speed — review a run without re-driving it. Save Map writes the accumulated 3D map as compressed .qpc (~4–6 bytes/point vs 16 raw).">
          Recording
        </div>
        <div className="sb-row">
          <button className="sb-btn sb-btn-rec" disabled={rec.recording || rec.busy}
                  onClick={rec.start}>Rec Start</button>
          <button className="sb-btn sb-btn-recstop" disabled={!rec.recording || rec.busy}
                  onClick={rec.stop}>Rec Stop</button>
        </div>
        {rec.path && <div className="sb-recpath">{rec.recording ? 'recording: ' : 'saved: '}{rec.path}</div>}
        <div className="sb-hint">replay: python -m robot_bridge.replay &lt;file&gt;</div>
        <button className="sb-btn sb-btn-wide" onClick={() => void saveMap()}>Save Map (.qpc)</button>
        {mapSaved && <div className="sb-recpath">{mapSaved}</div>}
      </div>
    </aside>
  )
}
