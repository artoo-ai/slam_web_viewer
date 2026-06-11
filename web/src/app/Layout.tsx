import { ViewportCanvas } from '../components/viewport/ViewportCanvas'
import { StatusBar } from '../components/panels/StatusBar'
import { StatsPanel } from '../components/panels/StatsPanel'
import { LogPanel } from '../components/panels/LogPanel'
import './layout.css'

export function Layout() {
  return (
    <div className="layout">
      <main className="layout-viewport">
        <ViewportCanvas />
      </main>
      <aside className="layout-sidebar">
        <StatsPanel />
        <LogPanel />
        {/* future panels: IMU, parameters, detections, camera, nav */}
      </aside>
      <footer className="layout-statusbar">
        <StatusBar />
      </footer>
    </div>
  )
}
