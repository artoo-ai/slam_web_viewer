import { useState } from 'react'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useNavStore } from '../../stores/navStore'
import { useObjectsStore } from '../../stores/objectsStore'
import { viewportRefs } from '../../lib/viewportRefs'
import { VelocityPanel } from '../panels/VelocityPanel'
import { ImuPanel } from '../panels/ImuPanel'
import { LogPanel } from '../panels/LogPanel'
import './chrome.css'

/** SJY-style floating bottom-center metrics card with tabs.
 *  Status tab: four big counters + velocity + nav state. */

type Tab = 'Status' | 'Rotation' | 'IMU' | 'Objects' | 'Log'

const TAB_TIPS: Record<Tab, string> = {
  Status: 'Session counters and navigation state at a glance.',
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

export function MetricsCard() {
  const [tab, setTab] = useState<Tab>('Status')
  const stats = useTelemetryStore((s) => s.stats)
  const navStatus = useNavStore((s) => s.status)
  const goal = useNavStore((s) => s.goal)
  const cancelGoal = useNavStore((s) => s.cancelGoal)
  const objects = useObjectsStore((s) => s.objects)

  return (
    <div className="metrics-card">
      <div className="mc-tabs">
        {(['Status', 'Rotation', 'IMU', 'Objects', 'Log'] as Tab[]).map((t) => (
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
          <div className="mc-rows">
            <span>scan {stats ? stats.scan_hz.toFixed(1) : '—'} Hz</span>
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
      {tab === 'Log' && <LogPanel />}
    </div>
  )
}
