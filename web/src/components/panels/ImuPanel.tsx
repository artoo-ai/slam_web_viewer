import { useEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { imuFeed } from '../../stores/imuFeed'
import { PanelShell } from './PanelShell'

/** IMU diagnostics: gyro xyz strip chart (30 s) + live accel readout.
 *  Watch for accel spikes (impacts/vibration) and gyro saturation. */

const PLOT_HEIGHT = 100

export function ImuPanel() {
  const plotEl = useRef<HTMLDivElement>(null)
  const lastVersion = useRef(-1)
  const [accel, setAccel] = useState<[number, number, number] | null>(null)

  useEffect(() => {
    if (!plotEl.current) return
    const u = new uPlot(
      {
        width: plotEl.current.clientWidth || 280,
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
          { stroke: '#f87171', width: 1, label: 'gx' },
          { stroke: '#34d399', width: 1, label: 'gy' },
          { stroke: '#38bdf8', width: 1.5, label: 'gz' },
        ],
      },
      [[], [], [], []],
      plotEl.current,
    )

    const timer = setInterval(() => {
      if (imuFeed.version === lastVersion.current) return
      lastVersion.current = imuFeed.version
      const [t, gx, gy, gz] = imuFeed.series
      const t0 = t.length ? t[t.length - 1] : 0
      u.setData([t.map((x) => x - t0), gx, gy, gz])
      setAccel(imuFeed.latest?.linear_accel ?? null)
    }, 200)

    return () => {
      clearInterval(timer)
      u.destroy()
    }
  }, [])

  return (
    <PanelShell title="IMU">
      <div className="velocity-readout">
        <span style={{ color: '#7d8a9c' }}>accel</span>
        <span>
          {accel ? accel.map((a) => a.toFixed(2)).join(' / ') : '— / — / —'} m/s²
        </span>
      </div>
      <div ref={plotEl} />
      <div className="imu-legend">
        <span style={{ color: '#f87171' }}>gx</span>
        <span style={{ color: '#34d399' }}>gy</span>
        <span style={{ color: '#38bdf8' }}>gz</span>
        <span style={{ color: '#7d8a9c' }}>rad/s</span>
      </div>
    </PanelShell>
  )
}
