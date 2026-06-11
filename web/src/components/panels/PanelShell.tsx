import type { ReactNode } from 'react'
import './panels.css'

/** Titled card container — the slot future panels (IMU, params, detections,
 *  nav, camera) mount into. */
export function PanelShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-header">{title}</header>
      <div className="panel-body">{children}</div>
    </section>
  )
}
