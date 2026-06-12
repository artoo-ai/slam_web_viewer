import { useEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { velocityFeed, WZ_CAP } from '../../stores/velocityFeed'
import { PanelShell } from './PanelShell'

/** Rotation tracking: commanded wz vs odometry-measured wz over a 30 s window.
 *  When the robot is told to spin and rf2o doesn't see it, scans are smearing
 *  into the map — the red alarm fires before slam_toolbox writes ghost walls. */

const PLOT_HEIGHT = 120

export function VelocityPanel() {
  const plotEl = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const lastVersion = useRef(-1)
  const [smearing, setSmearing] = useState(false)
  const [capHit, setCapHit] = useState(false)
  const [wz, setWz] = useState<{ cmd: number; odom: number } | null>(null)

  useEffect(() => {
    if (!plotEl.current) return
    const width = plotEl.current.clientWidth || 280
    const u = new uPlot(
      {
        width,
        height: PLOT_HEIGHT,
        padding: [8, 4, 0, 0],
        legend: { show: false },
        cursor: { show: false },
        scales: { x: { time: false } },
        axes: [
          { show: false },
          {
            stroke: '#7d8a9c',
            grid: { stroke: '#232c3a', width: 1 },
            ticks: { show: false },
            size: 36,
            font: '10px SF Mono, monospace',
          },
        ],
        series: [
          {},
          { stroke: '#38bdf8', width: 1.5, label: 'cmd wz' },
          { stroke: '#f59e0b', width: 1.5, label: 'odom wz' },
          { stroke: '#7d8a9c', width: 1, dash: [4, 4], label: 'cap' },
          { stroke: '#7d8a9c', width: 1, dash: [4, 4], label: '-cap' },
        ],
      },
      [[], [], [], [], []],
      plotEl.current,
    )
    plot.current = u

    const timer = setInterval(() => {
      if (velocityFeed.version === lastVersion.current) return
      lastVersion.current = velocityFeed.version
      const [t, cmdWz, odomWz] = velocityFeed.series
      const t0 = t.length ? t[t.length - 1] : 0
      u.setData([t.map((x) => x - t0), cmdWz, odomWz,
                 t.map(() => WZ_CAP), t.map(() => -WZ_CAP)])
      setSmearing(velocityFeed.smearing)
      setCapHit(velocityFeed.capExceeded)
      const latest = velocityFeed.latest
      setWz(latest ? { cmd: latest.cmd.wz, odom: latest.odom.wz } : null)
    }, 150)

    return () => {
      clearInterval(timer)
      u.destroy()
      plot.current = null
    }
  }, [])

  return (
    <PanelShell title="Rotation Tracking">
      {smearing && (
        <div className="smear-alarm">
          ⚠ ODOMETRY NOT TRACKING ROTATION — map smear imminent
        </div>
      )}
      {capHit && !smearing && (
        <div className="smear-alarm"
             title="Something commanded rotation above the 0.6 rad/s cap that should be deployed — a stale build is likely running. Check the Config tab.">
          ⚠ cmd wz exceeds 0.6 cap — stale build?
        </div>
      )}
      <div className="velocity-readout">
        <span style={{ color: '#38bdf8' }}>cmd {wz ? wz.cmd.toFixed(2) : '—'} rad/s</span>
        <span style={{ color: '#f59e0b' }}>odom {wz ? wz.odom.toFixed(2) : '—'} rad/s</span>
      </div>
      <div ref={plotEl} />
    </PanelShell>
  )
}
