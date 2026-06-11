import { ViewportCanvas } from '../components/viewport/ViewportCanvas'
import { StatusBar } from '../components/panels/StatusBar'
import { StatsPanel } from '../components/panels/StatsPanel'
import { NavPanel } from '../components/panels/NavPanel'
import { LayersPanel } from '../components/panels/LayersPanel'
import { CameraPanel } from '../components/panels/CameraPanel'
import { VelocityPanel } from '../components/panels/VelocityPanel'
import { ParameterPanel } from '../components/panels/ParameterPanel'
import { LogPanel } from '../components/panels/LogPanel'
import './layout.css'

export function Layout() {
  return (
    <div className="layout">
      <main className="layout-viewport">
        <ViewportCanvas />
      </main>
      <aside className="layout-sidebar">
        <CameraPanel />
        <LayersPanel />
        <VelocityPanel />
        <NavPanel />
        <ParameterPanel />
        <StatsPanel />
        <LogPanel />
        {/* future panels: IMU, parameters, detections, camera */}
      </aside>
      <footer className="layout-statusbar">
        <StatusBar />
      </footer>
    </div>
  )
}
