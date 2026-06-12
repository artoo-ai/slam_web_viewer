import { useEffect, useState } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useNavStore } from '../../stores/navStore'
import { useObjectsStore } from '../../stores/objectsStore'
import { useMissionStore } from '../../stores/missionStore'
import { useParamsAudit } from '../../stores/paramsAuditStore'
import { velocityFeed } from '../../stores/velocityFeed'
import { imuFeed } from '../../stores/imuFeed'
import { poseFeed } from '../../stores/poseFeed'
import { viewportRefs } from '../../lib/viewportRefs'
import { VelocityPanel } from '../panels/VelocityPanel'
import { ImuPanel } from '../panels/ImuPanel'
import { LogPanel } from '../panels/LogPanel'
import './chrome.css'

/** SJY-style floating bottom-center metrics card with tabs.
 *  Status tab: four big counters + velocity + nav state. */

type Tab = 'Status' | 'Rotation' | 'IMU' | 'Objects' | 'Config' | 'Log'

const TAB_TIPS: Record<Tab, string> = {
  Status: 'Session counters and navigation state at a glance.',
  Config:
    'Deployed-config audit: the live parameter values the robot is ACTUALLY running vs what they should be. Red row = stale build/deploy — rebuild before trusting any test result.',
  Rotation:
    'Commanded spin (blue) vs what odometry measured (amber). When blue spikes and amber stays flat, laser odometry is losing the rotation — scans smear into the map as ghost walls. The red alarm fires on exactly that.',
  IMU: 'Gyro rates (the IMU DOES see rotations laser odometry misses) and accelerometer — spikes = impacts/vibration.',
  Objects:
    'Semantic object memory: things detected on the map with a snapshot, label, confidence and position — like a robot vacuum’s object map. Click one to look at it.',
  Log: 'Bridge and SLAM events: map updates, goals, recordings, warnings.',
}

function fmtPts(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

function fmtDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m.toFixed(1)} m`
}

function fmtDur(s: number): string {
  return s >= 60 ? `${(s / 60).toFixed(1)} m` : `${s.toFixed(0)} s`
}

const MISSION_COLORS: Record<string, string> = {
  EXPLORING: 'var(--accent)',
  RETURNING: 'var(--warn)',
  DONE: 'var(--ok)',
  IDLE: 'var(--text-dim)',
}

function fmtField(key: string, v: number | string): string {
  if (typeof v !== 'number') return String(v)
  if (key.endsWith('_s')) {
    const m = Math.floor(v / 60)
    return `${m}:${String(Math.round(v % 60)).padStart(2, '0')}`
  }
  return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)
}

/** Live sensor readouts polled from the non-reactive feeds at 4 Hz. */
function useLiveReadouts() {
  const [live, setLive] = useState({
    vx: 0, wz: 0, accel: null as [number, number, number] | null,
    gyroZ: 0, poseHz: 0, smearing: false,
  })
  useEffect(() => {
    const t = setInterval(() => {
      const v = velocityFeed.latest
      const imu = imuFeed.latest
      setLive({
        vx: v?.odom.vx ?? 0,
        wz: v?.odom.wz ?? 0,
        accel: imu?.linear_accel ?? null,
        gyroZ: imu?.angular_vel[2] ?? 0,
        poseHz: poseFeed.hz,
        smearing: velocityFeed.smearing,
      })
    }, 250)
    return () => clearInterval(t)
  }, [])
  return live
}

function fmtVal(v: unknown): string {
  if (v === undefined || v === null) return '—'
  if (Array.isArray(v)) return `[${v.join(', ')}]`
  if (v === '') return '""'
  return String(v)
}

function ConfigAudit() {
  const { rows, mismatches, unknowns, stamp, refresh } = useParamsAudit()
  return (
    <div className="cfg-audit">
      <div className="cfg-head">
        <span className={mismatches ? 'cfg-bad' : unknowns ? 'cfg-warn' : 'cfg-ok'}>
          {mismatches ? `DEPLOYED ≠ EXPECTED (${mismatches})` :
           unknowns ? `${unknowns} unknown` :
           rows.length ? 'deployed config matches expected' : 'no audit data yet'}
        </span>
        <button className="mc-cancel" onClick={refresh}>refresh</button>
      </div>
      <div className="cfg-rows">
        {rows.map((r) => (
          <div key={`${r.node}/${r.param}`} className={`cfg-row cfg-row-${r.status}`} title={r.tip}>
            <span className="cfg-param">{r.param}<em>{r.node}</em></span>
            <span className="cfg-val">{fmtVal(r.deployed)}</span>
            <span className="cfg-exp">{r.expect === null ? 'per-run' : fmtVal(r.expect)}</span>
          </div>
        ))}
      </div>
      {stamp !== null && (
        <div className="cfg-stamp">read {new Date(stamp * 1000).toLocaleTimeString()}</div>
      )}
    </div>
  )
}

export function MetricsCard() {
  const [tab, setTab] = useState<Tab>('Status')
  const stats = useTelemetryStore((s) => s.stats)
  const navStatus = useNavStore((s) => s.status)
  const goal = useNavStore((s) => s.goal)
  const cancelGoal = useNavStore((s) => s.cancelGoal)
  const objects = useObjectsStore((s) => s.objects)
  const mission = useMissionStore((s) => s.mission)
  const live = useLiveReadouts()

  return (
    <div className="metrics-card">
      <div className="mc-tabs">
        {(['Status', 'Rotation', 'IMU', 'Objects', 'Config', 'Log'] as Tab[]).map((t) => (
          <button key={t} className={`mc-tab ${tab === t ? 'mc-tab-active' : ''}`}
                  title={TAB_TIPS[t]} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'Status' && (
        <div className="mc-status">
          <div className="mc-counters">
            <div className="mc-counter"
                 title="Map updates received from the SLAM backend (each one is a keyframe-ish event). Should grow steadily while exploring; stalled = SLAM stopped updating.">
              <span className="mc-num">{stats?.keyframes ?? '—'}</span>
              <span className="mc-label">KEYFRAMES</span>
            </div>
            <div className="mc-counter"
                 title="Cumulative LiDAR points streamed this session — a feel for data volume the pipeline is handling.">
              <span className="mc-num">{stats ? fmtPts(stats.total_pts) : '—'}</span>
              <span className="mc-label">TOTAL PTS</span>
            </div>
            <div className="mc-counter"
                 title="Distance traveled, integrated from odometry (SLAM-correction jumps filtered out). Sanity-check it against how far the robot really drove — big mismatch = odometry scale problems.">
              <span className="mc-num">{stats ? fmtDist(stats.distance_m) : '—'}</span>
              <span className="mc-label">DISTANCE</span>
            </div>
            <div className="mc-counter" title="Session duration since the bridge started.">
              <span className="mc-num">{stats ? fmtDur(stats.duration_s) : '—'}</span>
              <span className="mc-label">DURATION</span>
            </div>
          </div>
          <div className="mc-grid">
            <div className="mc-block"
                 title="Body velocities as ODOMETRY measures them. The km/h figure mirrors the SJY readout; angular is in deg/s.">
              <div className="mc-block-title">Velocity</div>
              <div className="mc-kv"><span>linear</span>
                <span>{live.vx.toFixed(2)} m/s ({(live.vx * 3.6).toFixed(1)} km/h)</span></div>
              <div className="mc-kv"><span>angular</span>
                <span>{((live.wz * 180) / Math.PI).toFixed(1)} °/s</span></div>
            </div>
            <div className="mc-block"
                 title={`Exploration node state (${mission ? 'live from /explore/status' : 'no mission data yet'}). Frontiers = unexplored boundary cells the robot can still drive to; exploration ends when none remain reachable.`}>
              <div className="mc-block-title">Exploration</div>
              {mission ? (
                <>
                  <div className="mc-state" style={{ color: MISSION_COLORS[mission.state] ?? 'var(--text)' }}>
                    {mission.state}
                  </div>
                  {Object.entries(mission.fields).slice(0, 4).map(([k, v]) => (
                    <div className="mc-kv" key={k}>
                      <span>{k.replace(/_/g, ' ')}</span>
                      <span>{fmtField(k, v)}</span>
                    </div>
                  ))}
                </>
              ) : (
                <div className="mc-kv"><span>—</span><span>waiting</span></div>
              )}
            </div>
            <div className="mc-block"
                 title="IMU at a glance: accel z should sit near 9.8 (gravity); spikes = impacts. gyro z is rotation rate — compare with the Rotation tab when spinning.">
              <div className="mc-block-title">IMU</div>
              <div className="mc-kv"><span>accel</span>
                <span>{live.accel ? live.accel.map((a) => a.toFixed(1)).join(' / ') : '—'}</span></div>
              <div className="mc-kv"><span>gyro z</span>
                <span>{live.gyroZ.toFixed(2)} rad/s</span></div>
            </div>
            <div className="mc-block"
                 title="Localization health: pose rate (rf2o ~10-20 Hz; 0 = no odometry), and whether commanded rotation is being tracked (SMEARING = laser odometry losing the spin -> ghost walls).">
              <div className="mc-block-title">Localization</div>
              <div className="mc-kv"><span>pose rate</span><span>{live.poseHz.toFixed(1)} Hz</span></div>
              <div className="mc-kv"><span>rotation</span>
                <span style={{ color: live.smearing ? 'var(--err)' : 'var(--ok)' }}>
                  {live.smearing ? 'SMEARING' : 'tracking'}
                </span></div>
              <div className="mc-kv"><span>scan</span><span>{stats ? stats.scan_hz.toFixed(1) : '—'} Hz</span></div>
            </div>
          </div>
          <div className="mc-rows">
            <span>
              nav:{' '}
              {navStatus ? (
                <>
                  {navStatus.state}
                  {navStatus.distance_m !== undefined && ` · ${navStatus.distance_m.toFixed(1)} m`}
                  {navStatus.eta_s !== undefined && ` · eta ${navStatus.eta_s.toFixed(0)} s`}
                </>
              ) : goal ? 'sending…' : 'idle — double-click map for goal'}
              {goal && (
                <button className="mc-cancel" onClick={cancelGoal}>cancel</button>
              )}
            </span>
          </div>
        </div>
      )}
      {tab === 'Rotation' && <VelocityPanel />}
      {tab === 'IMU' && <ImuPanel />}
      {tab === 'Objects' && (
        <div className="mc-objects">
          {objects.length === 0 && <div className="mc-empty">no objects detected yet</div>}
          {objects.map((o) => (
            <button key={o.id} className="mc-object" title="click to look at"
                    onClick={() => {
                      const c = viewportRefs.controls
                      if (c) {
                        c.target.set(o.p[0], o.p[1], o.p[2])
                        c.update()
                      }
                    }}>
              {o.thumbUrl ? (
                <img src={o.thumbUrl} alt={o.label} />
              ) : (
                <span className="mc-object-noimg">no img</span>
              )}
              <span className="mc-object-meta">
                <b>{o.label}</b> {(o.confidence * 100).toFixed(0)}%
                <br />({o.p[0].toFixed(1)}, {o.p[1].toFixed(1)}) · seen {o.count}×
              </span>
            </button>
          ))}
        </div>
      )}
      {tab === 'Config' && <ConfigAudit />}
      {tab === 'Log' && <LogPanel />}
    </div>
  )
}
