import './layout.css'

export function Layout() {
  return (
    <div className="layout">
      <main className="layout-viewport">{/* 3D viewport mounts here */}</main>
      <aside className="layout-sidebar">{/* panels mount here */}</aside>
      <footer className="layout-statusbar">{/* status bar mounts here */}</footer>
    </div>
  )
}
