import { ViewportCanvas } from '../components/viewport/ViewportCanvas'
import { HeaderBar } from '../components/chrome/HeaderBar'
import { Sidebar } from '../components/chrome/Sidebar'
import { MetricsCard } from '../components/chrome/MetricsCard'
import { DiagnosticsCard } from '../components/chrome/DiagnosticsCard'
import { BboxReadout, CameraInset, IntensityLegend } from '../components/chrome/Overlays'
import { StalenessStrip } from '../components/chrome/StalenessStrip'
import { AlertBanners } from '../components/chrome/AlertBanners'
import { TeleopPanel } from '../components/panels/TeleopPanel'
import { VrEntry } from '../vr/VrEntry'
import './layout.css'

/** SJY HandHeldSLAM-style chrome: header bar, left sidebar, viewport filling
 *  the rest with floating overlays (metrics card, legend, bbox, camera inset). */
export function Layout() {
  return (
    <div className="layout">
      <HeaderBar />
      <Sidebar />
      <main className="layout-viewport">
        <ViewportCanvas />
        <StalenessStrip />
        <AlertBanners />
        <MetricsCard />
        <DiagnosticsCard />
        <IntensityLegend />
        <CameraInset />
        <BboxReadout />
        <TeleopPanel />
        <VrEntry />
      </main>
    </div>
  )
}
