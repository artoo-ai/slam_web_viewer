import { useState } from 'react'
import { useLayersStore } from '../../stores/layersStore'
import { Rf2oPanel } from '../panels/Rf2oPanel'
import { SlamToolboxPanel } from '../panels/SlamToolboxPanel'
import { Nav2Panel } from '../panels/Nav2Panel'
import { RtabmapPanel } from '../panels/RtabmapPanel'
import { FastLioPanel } from '../panels/FastLioPanel'
import './chrome.css'

/** Floating bottom-left card with one tab per SLAM-stack component, for
 *  isolating a problem to a single stage. Collapsible (the sidebar's
 *  Diagnostics toggle, or the header chevron) so it never fights the
 *  bottom-center MetricsCard. */

type Tab = 'rf2o' | 'slam' | 'nav2' | 'rtabmap' | 'fastlio'

const TABS: { key: Tab; label: string; tip: string }[] = [
  { key: 'rf2o', label: 'rf2o',
    tip: '2D laser odometry (rf2o) health — the 2D stack’s /odom source.' },
  { key: 'slam', label: 'slam_toolbox',
    tip: '2D graph SLAM: map coverage, pose-graph growth, map→odom correction.' },
  { key: 'nav2', label: 'nav2',
    tip: 'Navigation: behavior-tree leaf, recoveries, plan length, controller cmd.' },
  { key: 'rtabmap', label: 'rtabmap',
    tip: '3D graph SLAM: loop closures, processing time, memory (3D stack).' },
  { key: 'fastlio', label: 'fast-lio2',
    tip: 'Lidar-inertial odometry — the 3D stack’s /Odometry source.' },
]

export function DiagnosticsCard() {
  const visible = useLayersStore((s) => s.diagnostics)
  const toggle = useLayersStore((s) => s.toggle)
  const [tab, setTab] = useState<Tab>('rf2o')

  if (!visible) {
    return (
      <button
        className="diag-card-collapsed"
        title="Show per-component SLAM diagnostics"
        onClick={() => toggle('diagnostics')}>
        ▸ SLAM Diagnostics
      </button>
    )
  }

  return (
    <div className="diag-card">
      <div className="diag-card-head">
        <span className="diag-card-title">SLAM Diagnostics</span>
        <button
          className="diag-collapse"
          title="Collapse"
          onClick={() => toggle('diagnostics')}>
          ▾
        </button>
      </div>
      <div className="diag-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`diag-tab ${tab === t.key ? 'diag-tab-active' : ''}`}
            title={t.tip}
            onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="diag-panel">
        {tab === 'rf2o' && <Rf2oPanel />}
        {tab === 'slam' && <SlamToolboxPanel />}
        {tab === 'nav2' && <Nav2Panel />}
        {tab === 'rtabmap' && <RtabmapPanel />}
        {tab === 'fastlio' && <FastLioPanel />}
      </div>
    </div>
  )
}
