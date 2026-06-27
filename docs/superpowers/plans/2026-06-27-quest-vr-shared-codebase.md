# Meta Quest VR (shared codebase) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing robot_gui web viewer run inside a Meta Quest headset (immersive WebXR) from the same codebase and same URL, with locomotion through the point cloud and a floating in-scene HUD — delivering the approved "thin vertical slice."

**Architecture:** One `<Canvas>` wrapped in `@react-three/xr`'s `<XR>`. All 3D layers move into a shared `<SceneContent>` that both desktop (OrbitControls + DOM chrome, unchanged) and VR (locomotion + uikit HUD) render. A `<SceneRoot>` applies a Z-up→Y-up rotation and a grabbable world-scale, but only while an XR session is active, so desktop stays pixel-identical. VR-only UI lives under `web/src/vr/`; the data layer (transport, Zustand stores, protocol) is untouched and shared.

**Tech Stack:** React 19, @react-three/fiber 9, @react-three/drei 10, three 0.184, Zustand 5, Vite 8, Vitest 4, TypeScript ~5.9, plus new: @react-three/xr v6, @react-three/uikit (+ uikit-default), @vitejs/plugin-basic-ssl.

> **Note on spec refinement:** the design doc sketched separate `ViewportCanvas`/`VRCanvas` shells. During planning this was refined to a single XR-wrapped Canvas (the standard @react-three/xr pattern) to avoid two canvases on one page. Same intent — the only fork remains the shell controls + HUD.

## Global Constraints

- React 19 + @react-three/fiber 9.x + @react-three/drei 10.x must stay in lockstep — do not bump any of the three without the others.
- three pinned at 0.184.0; TypeScript pinned ~5.9 (NOT 6.0).
- Browser has ZERO ROS2 dependency — nothing in this plan touches transport/protocol.
- Desktop chrome (DOM HTML/CSS panels in `web/src/components/chrome` and `components/panels`) must remain visually and behaviorally unchanged. uikit is VR-only.
- WebXR requires a secure context: HTTPS or `localhost`. Plain `http://<lan-ip>` will not offer "Enter VR."
- World is REP-103 Z-up; WebXR player space is Y-up. The rotation `[-Math.PI/2, 0, 0]` maps scene-up (+Z) to world-up (+Y).
- All new VR code lives under `web/src/vr/`; the shared scene component lives at `web/src/components/viewport/SceneContent.tsx`.
- Run a single test file with: `cd web && npx vitest run <path>`. There is no `test` npm script.
- Commit after every task. No co-author trailers.

---

### Task 1: Extract `<SceneContent>` (pure refactor, no behavior change)

Move everything currently *inside* `<Canvas>` in `ViewportCanvas.tsx` except `OrbitControls` into a new shared `SceneContent` component. Desktop must look and behave identically afterward.

**Files:**
- Create: `web/src/components/viewport/SceneContent.tsx`
- Modify: `web/src/components/viewport/ViewportCanvas.tsx`

**Interfaces:**
- Produces: `SceneContent` — a zero-prop React component rendering Grid, axesHelper, all viewport layers, and `ViewportBridge`. Imported by the desktop Canvas now and the VR shell later.

- [ ] **Step 1: Create `SceneContent.tsx`**

```tsx
import { Grid } from '@react-three/drei'
import { PointCloudViewer } from './PointCloudViewer'
import { ScanLowLayer } from './ScanLowLayer'
import { ScanMainLayer } from './ScanMainLayer'
import { DepthPointsLayer } from './DepthPointsLayer'
import { MapPointsLayer } from './MapPointsLayer'
import { TrajectoryOverlay } from './TrajectoryOverlay'
import { RobotPoseGlyph } from './RobotPoseGlyph'
import { OccupancyGridLayer } from './OccupancyGridLayer'
import { PathOverlay } from './PathOverlay'
import { GoalClickPlane, GoalMarker } from './GoalControls'
import { ObjectMarkers } from './ObjectMarkers'
import { ViewportBridge } from './ViewportBridge'

/** Every 3D layer of the scene, with no camera/controls. Shared verbatim by the
 *  desktop Canvas and the VR (XR) shell so new layers appear in both automatically. */
export function SceneContent() {
  return (
    <>
      <ViewportBridge />
      {/* drei Grid lies in the XZ plane by default — rotate onto XY (the floor) */}
      <Grid
        rotation={[Math.PI / 2, 0, 0]}
        args={[40, 40]}
        cellSize={1}
        cellColor="#2a3546"
        sectionSize={5}
        sectionColor="#3b4a61"
        fadeDistance={60}
        infiniteGrid
      />
      <axesHelper args={[1]} />
      <PointCloudViewer />
      <ScanLowLayer />
      <ScanMainLayer />
      <DepthPointsLayer />
      <MapPointsLayer />
      <TrajectoryOverlay />
      <RobotPoseGlyph />
      <OccupancyGridLayer layer="map" palette="map" z={0.01} />
      <OccupancyGridLayer layer="costmap_global" palette="cost" z={0.02} />
      <OccupancyGridLayer layer="costmap_local" palette="cost" z={0.03} />
      <PathOverlay />
      <GoalClickPlane />
      <GoalMarker />
      <ObjectMarkers />
    </>
  )
}
```

- [ ] **Step 2: Rewrite `ViewportCanvas.tsx` to use it**

```tsx
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { SceneContent } from './SceneContent'

/** Desktop 3D scene. World is REP-103 z-up — camera.up must be set before
 *  OrbitControls initializes, hence via the camera prop. preserveDrawingBuffer
 *  keeps toBlob() screenshots valid. */
export function ViewportCanvas() {
  return (
    <Canvas
      camera={{ position: [-6, -6, 4], up: [0, 0, 1], fov: 60, near: 0.05, far: 400 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      style={{ background: 'var(--bg)' }}
    >
      <OrbitControls makeDefault target={[0, 0, 0.5]} />
      <SceneContent />
    </Canvas>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Visual parity check**

Run: `cd web && npm run dev`, open the app, confirm the 3D scene (grid, axes, point cloud, all overlays, orbit/zoom) looks and behaves exactly as before. This is a pure move — nothing should change.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/viewport/SceneContent.tsx web/src/components/viewport/ViewportCanvas.tsx
git commit -m "refactor: extract SceneContent from ViewportCanvas for VR reuse"
```

---

### Task 2: Add dependencies + HTTPS dev server

Install the XR/uikit libraries and make `vite dev` serve over HTTPS on the LAN so the Quest browser will offer "Enter VR."

**Files:**
- Modify: `web/package.json` (deps — via npm install)
- Modify: `web/vite.config.ts`

**Interfaces:**
- Produces: a LAN-reachable `https://<dev-ip>:5173` dev URL; the packages `@react-three/xr`, `@react-three/uikit`, `@react-three/uikit-default` available to import.

- [ ] **Step 1: Install runtime deps**

```bash
cd web && npm install @react-three/xr @react-three/uikit @react-three/uikit-default
```

- [ ] **Step 2: Verify peer compatibility**

Run: `cd web && npm ls three @react-three/fiber @react-three/drei @react-three/xr`
Expected: a single `three@0.184.0`, `@react-three/fiber@9.x`, `@react-three/drei@10.x`, and `@react-three/xr@6.x` with no `UNMET PEER DEPENDENCY` / no duplicate three. If npm reports a conflict, stop and report the exact versions — do not force-install.

- [ ] **Step 3: Install the HTTPS dev plugin**

```bash
cd web && npm install -D @vitejs/plugin-basic-ssl
```

- [ ] **Step 4: Update `vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true, // expose on the LAN so the Quest browser can reach it
  },
})
```

- [ ] **Step 5: Verify HTTPS + LAN**

Run: `cd web && npm run dev`
Expected: Vite prints a `Network: https://<your-lan-ip>:5173/` line. Open that HTTPS URL in a desktop browser, accept the self-signed cert warning once, confirm the app loads. (The Quest browser will show the same one-time cert warning — that is expected with a self-signed cert.)

- [ ] **Step 6: Typecheck + commit**

```bash
cd web && npx tsc -b
git add web/package.json web/package-lock.json web/vite.config.ts
git commit -m "build: add @react-three/xr + uikit deps and HTTPS LAN dev server"
```

---

### Task 3: `vrModeStore` — VR session mode + world scale (TDD)

A small Zustand store holding which session is active and the grabbable uniform world scale, with a clamped setter. Pure logic — fully unit-tested.

**Files:**
- Create: `web/src/stores/vrModeStore.ts`
- Test: `web/src/stores/vrModeStore.test.ts`

**Interfaces:**
- Produces:
  - `type VrSessionMode = 'none' | 'vr' | 'ar'`
  - `useVrStore` with `{ mode, worldScale, setMode(mode), setWorldScale(scale) }`
  - `clampWorldScale(scale: number): number`
  - `MIN_WORLD_SCALE = 0.02`, `MAX_WORLD_SCALE = 5`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { useVrStore, clampWorldScale, MIN_WORLD_SCALE, MAX_WORLD_SCALE } from './vrModeStore'

describe('vrModeStore', () => {
  beforeEach(() => useVrStore.setState({ mode: 'none', worldScale: 1 }))

  it('clamps world scale to the allowed range', () => {
    expect(clampWorldScale(1)).toBe(1)
    expect(clampWorldScale(0.0001)).toBe(MIN_WORLD_SCALE)
    expect(clampWorldScale(999)).toBe(MAX_WORLD_SCALE)
  })

  it('setMode updates the active session mode', () => {
    useVrStore.getState().setMode('ar')
    expect(useVrStore.getState().mode).toBe('ar')
  })

  it('setWorldScale clamps before storing', () => {
    useVrStore.getState().setWorldScale(999)
    expect(useVrStore.getState().worldScale).toBe(MAX_WORLD_SCALE)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/stores/vrModeStore.test.ts`
Expected: FAIL — cannot resolve `./vrModeStore`.

- [ ] **Step 3: Implement the store**

```ts
import { create } from 'zustand'

export type VrSessionMode = 'none' | 'vr' | 'ar'

export const MIN_WORLD_SCALE = 0.02
export const MAX_WORLD_SCALE = 5

/** Uniform scale of the whole cloud, set by the two-handed grab gesture. */
export function clampWorldScale(scale: number): number {
  return Math.min(MAX_WORLD_SCALE, Math.max(MIN_WORLD_SCALE, scale))
}

interface VrState {
  mode: VrSessionMode
  worldScale: number
  setMode: (mode: VrSessionMode) => void
  setWorldScale: (scale: number) => void
}

export const useVrStore = create<VrState>((set) => ({
  mode: 'none',
  worldScale: 1,
  setMode: (mode) => set({ mode }),
  setWorldScale: (scale) => set({ worldScale: clampWorldScale(scale) }),
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/stores/vrModeStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/stores/vrModeStore.ts web/src/stores/vrModeStore.test.ts
git commit -m "feat: vrModeStore for session mode and grabbable world scale"
```

---

### Task 4: Coordinate helper + `<SceneRoot>` wrapper (TDD for the math)

Provide the Z-up→Y-up rotation constant (unit-tested against three's math) and a `<SceneRoot>` that applies it plus the world scale, but only while an XR session is active.

**Files:**
- Create: `web/src/vr/coords.ts`
- Test: `web/src/vr/coords.test.ts`
- Create: `web/src/vr/SceneRoot.tsx`

**Interfaces:**
- Consumes: `useVrStore` (Task 3); `useXR` from `@react-three/xr`.
- Produces:
  - `Z_UP_TO_Y_UP: [number, number, number]` — Euler XYZ rotation.
  - `SceneRoot` — wraps `children` in a `<group>`; applies `Z_UP_TO_Y_UP` + `worldScale` when in an XR session, identity otherwise.

- [ ] **Step 1: Write the failing test for the rotation**

```ts
import { describe, expect, it } from 'vitest'
import { Euler, Vector3 } from 'three'
import { Z_UP_TO_Y_UP } from './coords'

describe('Z_UP_TO_Y_UP', () => {
  it('maps scene-up (+Z) to world-up (+Y)', () => {
    const v = new Vector3(0, 0, 1).applyEuler(new Euler(...Z_UP_TO_Y_UP))
    expect(v.x).toBeCloseTo(0, 5)
    expect(v.y).toBeCloseTo(1, 5)
    expect(v.z).toBeCloseTo(0, 5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/vr/coords.test.ts`
Expected: FAIL — cannot resolve `./coords`.

- [ ] **Step 3: Implement `coords.ts`**

```ts
/** REP-103 world is Z-up; WebXR player space is Y-up. Rotating the scene by
 *  -90° about X maps scene +Z onto world +Y so the map floor is the real floor. */
export const Z_UP_TO_Y_UP: [number, number, number] = [-Math.PI / 2, 0, 0]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/vr/coords.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement `SceneRoot.tsx`**

```tsx
import type { ReactNode } from 'react'
import { useXR } from '@react-three/xr'
import { useVrStore } from '../stores/vrModeStore'
import { Z_UP_TO_Y_UP } from './coords'

/** Wraps the shared scene. Only inside an active XR session does it rotate
 *  Z-up→Y-up and apply the grabbed world scale; on the desktop (no session)
 *  it is the identity, so OrbitControls behaves exactly as before. */
export function SceneRoot({ children }: { children: ReactNode }) {
  const inXR = useXR((s) => s.session != null)
  const worldScale = useVrStore((s) => s.worldScale)
  return (
    <group
      rotation={inXR ? Z_UP_TO_Y_UP : [0, 0, 0]}
      scale={inXR ? worldScale : 1}
    >
      {children}
    </group>
  )
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd web && npx tsc -b` (expected: no errors)

```bash
git add web/src/vr/coords.ts web/src/vr/coords.test.ts web/src/vr/SceneRoot.tsx
git commit -m "feat: Z-up→Y-up coord helper and XR-only SceneRoot wrapper"
```

---

### Task 5: XR store + wrap the Canvas in `<XR>` (desktop stays identical)

Create the XR store, wrap the existing Canvas contents in `<XR>`, route the scene through `SceneRoot`, and disable OrbitControls while in a session. With no session active, the page is unchanged.

**Files:**
- Create: `web/src/vr/xrStore.ts`
- Create: `web/src/vr/DesktopControls.tsx`
- Modify: `web/src/components/viewport/ViewportCanvas.tsx`

**Interfaces:**
- Consumes: `SceneContent` (Task 1), `SceneRoot` (Task 4), `useVrStore` (Task 3).
- Produces:
  - `xrStore` — the `createXRStore()` instance, imported by entry buttons and locomotion.
  - `DesktopControls` — renders `OrbitControls` only when no XR session is active.
  - `ViewportCanvas` now hosts `<XR store={xrStore}>`.

- [ ] **Step 1: Create `xrStore.ts`**

```ts
import { createXRStore } from '@react-three/xr'

/** Single XR session store for the app. `enterVR()` / `enterAR()` start the
 *  immersive session; hand-tracking enabled so the grab/teleport gestures work
 *  with controllers or hands. */
export const xrStore = createXRStore({ hand: true, controller: true })
```

- [ ] **Step 2: Create `DesktopControls.tsx`**

```tsx
import { OrbitControls } from '@react-three/drei'
import { useXR } from '@react-three/xr'

/** Mouse orbit/zoom for the flat desktop view. Suppressed during an XR session
 *  so it never fights headset head-tracking. */
export function DesktopControls() {
  const inXR = useXR((s) => s.session != null)
  if (inXR) return null
  return <OrbitControls makeDefault target={[0, 0, 0.5]} />
}
```

- [ ] **Step 3: Rewrite `ViewportCanvas.tsx`**

```tsx
import { Canvas } from '@react-three/fiber'
import { XR } from '@react-three/xr'
import { SceneContent } from './SceneContent'
import { SceneRoot } from '../../vr/SceneRoot'
import { DesktopControls } from '../../vr/DesktopControls'
import { xrStore } from '../../vr/xrStore'

/** One Canvas for both desktop and VR. Wrapped in <XR>: with no session it
 *  renders the flat desktop scene (OrbitControls + DOM chrome). On enterVR()/
 *  enterAR() the headset takes over and SceneRoot reorients to Y-up. */
export function ViewportCanvas() {
  return (
    <Canvas
      camera={{ position: [-6, -6, 4], up: [0, 0, 1], fov: 60, near: 0.05, far: 400 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      style={{ background: 'var(--bg)' }}
    >
      <XR store={xrStore}>
        <DesktopControls />
        <SceneRoot>
          <SceneContent />
        </SceneRoot>
      </XR>
    </Canvas>
  )
}
```

- [ ] **Step 4: Typecheck**

Run: `cd web && npx tsc -b`
Expected: no errors. If `@react-three/xr` v6 exports differ (e.g. `useXR` selector shape), consult `web/node_modules/@react-three/xr/README.md` and adjust the `useXR((s) => s.session != null)` selectors in this and Task 4 to match the installed version, then re-run.

- [ ] **Step 5: Desktop parity check**

Run: `cd web && npm run dev`. Confirm the desktop app is unchanged — orbit/zoom works, all layers render, DOM chrome intact. (No way to enter a session yet; that is Task 7.)

- [ ] **Step 6: Commit**

```bash
git add web/src/vr/xrStore.ts web/src/vr/DesktopControls.tsx web/src/components/viewport/ViewportCanvas.tsx
git commit -m "feat: wrap viewport Canvas in XR, suppress OrbitControls in session"
```

---

### Task 6: Locomotion — teleport, walk, two-handed grab-to-scale

Add the in-session locomotion rig: room-scale walking is automatic via the XR origin; controller teleport repositions the origin; a two-handed squeeze scales the world via `vrModeStore`. Tuning happens in-headset.

**Files:**
- Create: `web/src/vr/Locomotion.tsx`
- Modify: `web/src/components/viewport/ViewportCanvas.tsx` (mount `<Locomotion/>`)

**Interfaces:**
- Consumes: `xrStore`, `useVrStore.setWorldScale`, `@react-three/xr` (`XROrigin`, `TeleportTarget`, controller/hand state).
- Produces: `Locomotion` — a component, rendered inside `<XR>`, that owns the `XROrigin` and movement gestures.

- [ ] **Step 1: Implement `Locomotion.tsx`**

```tsx
import { useRef } from 'react'
import { Vector3, type Group } from 'three'
import { XROrigin, TeleportTarget } from '@react-three/xr'
import { useVrStore, clampWorldScale } from '../stores/vrModeStore'

/** Locomotion rig (in-session only):
 *  - room-scale walking: free, handled by the headset moving inside XROrigin
 *  - teleport: point at the floor target and trigger to move the origin
 *  - grab-to-scale: handled in Step 2's gesture (two-handed squeeze)
 *  The floor target is a large invisible plane at the world floor (y=0). */
export function Locomotion() {
  const origin = useRef<Group>(null)
  const position = useRef(new Vector3(0, 0, 0))

  return (
    <>
      <XROrigin ref={origin} position={position.current} />
      <TeleportTarget
        onTeleport={(p) => {
          position.current.copy(p)
          if (origin.current) origin.current.position.copy(p)
        }}
      >
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
          <planeGeometry args={[200, 200]} />
          <meshBasicMaterial visible={false} />
        </mesh>
      </TeleportTarget>
    </>
  )
}
```

- [ ] **Step 2: Add the two-handed grab-to-scale gesture**

Append the gesture inside `Locomotion` using a `useFrame` that reads both controllers'/hands' squeeze state from the XR store and scales by the ratio of current-to-initial hand distance. Replace the component body's `return` region with the version below (keeps Step 1's teleport, adds scaling):

```tsx
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector3, type Group } from 'three'
import { XROrigin, TeleportTarget, useXRInputSourceStateContext } from '@react-three/xr'
import { useVrStore, clampWorldScale } from '../stores/vrModeStore'

export function Locomotion() {
  const origin = useRef<Group>(null)
  const position = useRef(new Vector3(0, 0, 0))
  const grab = useRef<{ startDist: number; startScale: number } | null>(null)

  useFrame((state) => {
    const session = state.gl.xr.getSession()
    if (!session) { grab.current = null; return }
    const squeezing = [...session.inputSources].filter((s) => s.gamepad?.buttons?.[1]?.pressed)
    if (squeezing.length < 2) { grab.current = null; return }
    const [a, b] = squeezing
    const frame = state.gl.xr.getFrame?.()
    const ref = state.gl.xr.getReferenceSpace?.()
    if (!frame || !ref) return
    const pa = frame.getPose(a.gripSpace!, ref)?.transform.position
    const pb = frame.getPose(b.gripSpace!, ref)?.transform.position
    if (!pa || !pb) return
    const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z)
    if (!grab.current) {
      grab.current = { startDist: dist, startScale: useVrStore.getState().worldScale }
    } else {
      const next = clampWorldScale(grab.current.startScale * (dist / grab.current.startDist))
      useVrStore.getState().setWorldScale(next)
    }
  })

  return (
    <>
      <XROrigin ref={origin} position={position.current} />
      <TeleportTarget
        onTeleport={(p) => {
          position.current.copy(p)
          if (origin.current) origin.current.position.copy(p)
        }}
      >
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
          <planeGeometry args={[200, 200]} />
          <meshBasicMaterial visible={false} />
        </mesh>
      </TeleportTarget>
    </>
  )
}
```

(`useXRInputSourceStateContext` import is left available if the installed v6 API exposes a cleaner squeeze selector than reading `gamepad.buttons[1]`; prefer it if present — confirm in Step 3.)

- [ ] **Step 2b: Mount `<Locomotion/>` in the Canvas**

In `web/src/components/viewport/ViewportCanvas.tsx`, add the import and render it inside `<XR>` just before `<SceneRoot>`:

```tsx
import { Locomotion } from '../../vr/Locomotion'
// ...
      <XR store={xrStore}>
        <DesktopControls />
        <Locomotion />
        <SceneRoot>
          <SceneContent />
        </SceneRoot>
      </XR>
```

- [ ] **Step 3: Reconcile with the installed @react-three/xr v6 API**

Run: `cd web && npx tsc -b`. If `TeleportTarget`, `XROrigin`, or the squeeze-reading approach do not type-check, open `web/node_modules/@react-three/xr/docs` or its README, find the v6 equivalents (v6 renamed several v5 APIs), and adjust. Expected end state: no type errors.

- [ ] **Step 4: Commit (in-headset verification deferred to Task 7)**

```bash
git add web/src/vr/Locomotion.tsx web/src/components/viewport/ViewportCanvas.tsx
git commit -m "feat: VR locomotion — teleport, room-scale, two-handed grab-to-scale"
```

---

### Task 7: Entry buttons + first in-headset verification

Add the DOM "Enter VR" / "Enter Passthrough" buttons (shown only when WebXR is available) and keep `vrModeStore.mode` in sync with the session. This is the first task you can actually test in the headset.

**Files:**
- Create: `web/src/vr/VrEntry.tsx`
- Create: `web/src/vr/vrEntry.css`
- Modify: `web/src/app/Layout.tsx` (render `<VrEntry/>` in the overlay)

**Interfaces:**
- Consumes: `xrStore` (Task 5), `useVrStore.setMode` (Task 3).
- Produces: `VrEntry` — a DOM overlay component with the two entry buttons; auto-hides when `navigator.xr` / the mode is unsupported.

- [ ] **Step 1: Implement `VrEntry.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { xrStore } from '../vr/xrStore'
import { useVrStore } from '../stores/vrModeStore'
import './vrEntry.css'

/** DOM buttons (visible only on the flat page) to start an immersive session.
 *  WebXR forbids auto-entry — a user tap is required, so these live in the DOM
 *  chrome, not in-scene. Hidden entirely on browsers without WebXR. */
export function VrEntry() {
  const [vrOk, setVrOk] = useState(false)
  const [arOk, setArOk] = useState(false)
  const setMode = useVrStore((s) => s.setMode)

  useEffect(() => {
    const xr = navigator.xr
    if (!xr) return
    xr.isSessionSupported('immersive-vr').then(setVrOk).catch(() => setVrOk(false))
    xr.isSessionSupported('immersive-ar').then(setArOk).catch(() => setArOk(false))
  }, [])

  if (!vrOk && !arOk) return null
  return (
    <div className="vr-entry">
      {vrOk && (
        <button onClick={() => { setMode('vr'); xrStore.enterVR().catch(() => setMode('none')) }}>
          Enter VR
        </button>
      )}
      {arOk && (
        <button onClick={() => { setMode('ar'); xrStore.enterAR().catch(() => setMode('none')) }}>
          Enter Passthrough
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add `vrEntry.css`**

```css
.vr-entry {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  gap: 8px;
  z-index: 20;
}
.vr-entry button {
  padding: 8px 14px;
  font: inherit;
  color: #e8eef7;
  background: #1c2839;
  border: 1px solid #3b4a61;
  border-radius: 6px;
  cursor: pointer;
}
.vr-entry button:hover { background: #243349; }
```

- [ ] **Step 3: Render it in `Layout.tsx`**

Add the import and place `<VrEntry/>` as the last child of `<main className="layout-viewport">`:

```tsx
import { VrEntry } from '../vr/VrEntry'
// ...inside <main className="layout-viewport"> after <TeleopPanel />:
        <VrEntry />
```

- [ ] **Step 4: Keep session mode in sync on exit**

In `web/src/vr/xrStore.ts`, subscribe to session end so `mode` resets when the user leaves VR via the system button:

```ts
import { createXRStore } from '@react-three/xr'
import { useVrStore } from '../stores/vrModeStore'

export const xrStore = createXRStore({ hand: true, controller: true })

// Reset the store's mode whenever the session ends (system Meta button, etc.)
xrStore.subscribe((state) => {
  if (state.session == null) useVrStore.getState().setMode('none')
})
```

(If the v6 store's subscribe selector shape differs, adjust to read the session field per `node_modules/@react-three/xr/README.md`.)

- [ ] **Step 5: Typecheck + desktop check**

Run: `cd web && npx tsc -b` (expected: no errors).
Run: `cd web && npm run dev`. On the desktop the buttons should NOT appear (no WebXR) or appear harmlessly — desktop scene unchanged.

- [ ] **Step 6: In-headset verification**

On the Meta Quest: open the Quest Browser → navigate to `https://<dev-ip>:5173` → accept the cert warning → tap **Enter VR**. Confirm:
- you drop into the scene and the map floor aligns with your real floor (Z-up fix),
- head-tracking + room-scale walking work,
- pointing at the floor and triggering teleports you,
- a two-handed squeeze grows/shrinks the cloud,
- tapping the system button exits back to the flat page.
Then tap **Enter Passthrough** and confirm your real room shows behind the cloud.
Note any glitches for tuning; small numeric tweaks (teleport plane size, scale limits in `vrModeStore`) are fine to adjust now.

- [ ] **Step 7: Commit**

```bash
git add web/src/vr/VrEntry.tsx web/src/vr/vrEntry.css web/src/vr/xrStore.ts web/src/app/Layout.tsx
git commit -m "feat: Enter VR/Passthrough buttons + session-mode sync (first headset run)"
```

---

### Task 8: Core uikit HUD (the thin-slice deliverable)

Add the floating in-scene HUD shown only during a session: connection status, live Points/FPS, the Layers toggles (reusing `layersStore`), and a Void/Passthrough mode switch. This completes the approved slice.

**Files:**
- Create: `web/src/vr/VrHud.tsx`
- Modify: `web/src/components/viewport/ViewportCanvas.tsx` (mount `<VrHud/>` inside `<XR>`)

**Interfaces:**
- Consumes: `@react-three/uikit` (`Root`, `Container`, `Text`), `@react-three/uikit-default` button if used; `useConnectionStore`, `useLayersStore`, `useVrStore`; `mapFeed`, `scanFeed` (`.count`), `fpsMeter.fps` from `lib/viewportRefs`; `xrStore`.
- Produces: `VrHud` — an in-scene uikit panel attached in front of the camera, rendered only when `useVrStore.mode !== 'none'`.

- [ ] **Step 1: Implement `VrHud.tsx`**

```tsx
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Root, Container, Text } from '@react-three/uikit'
import type { Group } from 'three'
import { useConnectionStore } from '../stores/connectionStore'
import { useLayersStore, type LayerVisibility } from '../stores/layersStore'
import { useVrStore } from '../stores/vrModeStore'
import { xrStore } from './xrStore'
import { mapFeed } from '../stores/mapFeed'
import { scanFeed } from '../stores/scanFeed'
import { fpsMeter } from '../lib/viewportRefs'

/** Floating VR HUD (session-only). Parented to a group we lock ~1.2m in front of
 *  the camera each frame so it follows the operator. Continuous readouts are
 *  updated imperatively at ~10 Hz (not per-frame) to keep VR framerate. */
const HUD_LAYERS: (keyof LayerVisibility)[] = [
  'scan', 'map_points', 'trajectory', 'map', 'costmap_global', 'costmap_local', 'path',
]

export function VrHud() {
  const mode = useVrStore((s) => s.mode)
  const status = useConnectionStore((s) => s.status)
  const layers = useLayersStore()
  const toggle = useLayersStore((s) => s.toggle)
  const setMode = useVrStore((s) => s.setMode)

  const hudRef = useRef<Group>(null)
  const ptsRef = useRef<{ setText?: (t: string) => void }>({})
  const lastUpdate = useRef(0)

  useFrame((state) => {
    // Lock the HUD in front of the camera (simple head-locked placement).
    if (hudRef.current) {
      const cam = state.camera
      hudRef.current.position.copy(cam.position)
      hudRef.current.quaternion.copy(cam.quaternion)
      hudRef.current.translateZ(-1.2)
    }
    // Throttle the Points/FPS text to ~10 Hz.
    const t = state.clock.elapsedTime
    if (t - lastUpdate.current > 0.1) {
      lastUpdate.current = t
      ptsRef.current.setText?.(
        `Points ${(mapFeed.count + scanFeed.count).toLocaleString()}  ·  ${fpsMeter.fps} FPS`,
      )
    }
  })

  if (mode === 'none') return null

  return (
    <group ref={hudRef}>
      <Root pixelSize={0.0016} anchorX="center" anchorY="center">
        <Container
          flexDirection="column"
          gap={8}
          padding={14}
          borderRadius={10}
          backgroundColor="#141d2b"
          backgroundOpacity={0.92}
          width={420}
        >
          <Text fontSize={20} color="#e8eef7">Robot GUI · VR</Text>
          <Text fontSize={14} color={status === 'open' ? '#5fd08a' : '#d0825f'}>
            {status === 'open' ? 'Connected' : status}
          </Text>
          <Text
            fontSize={14}
            color="#9fb2cc"
            ref={(node: unknown) => {
              // uikit Text exposes imperative setText; capture it for the 10 Hz loop.
              ptsRef.current.setText = (node as { setText?: (t: string) => void })?.setText
            }}
          >
            Points 0 · 0 FPS
          </Text>

          <Text fontSize={13} color="#7f93ad">Layers</Text>
          <Container flexDirection="row" flexWrap="wrap" gap={6}>
            {HUD_LAYERS.map((key) => (
              <Container
                key={key}
                paddingX={10}
                paddingY={6}
                borderRadius={6}
                backgroundColor={layers[key] ? '#2f6df0' : '#27344a'}
                onClick={() => toggle(key)}
              >
                <Text fontSize={12} color="#e8eef7">{key}</Text>
              </Container>
            ))}
          </Container>

          <Container flexDirection="row" gap={8}>
            <Container
              paddingX={12} paddingY={8} borderRadius={6}
              backgroundColor={mode === 'vr' ? '#2f6df0' : '#27344a'}
              onClick={() => { setMode('vr'); xrStore.enterVR().catch(() => {}) }}
            >
              <Text fontSize={13} color="#e8eef7">Void</Text>
            </Container>
            <Container
              paddingX={12} paddingY={8} borderRadius={6}
              backgroundColor={mode === 'ar' ? '#2f6df0' : '#27344a'}
              onClick={() => { setMode('ar'); xrStore.enterAR().catch(() => {}) }}
            >
              <Text fontSize={13} color="#e8eef7">Passthrough</Text>
            </Container>
          </Container>
        </Container>
      </Root>
    </group>
  )
}
```

- [ ] **Step 2: Mount `<VrHud/>` in the Canvas**

In `web/src/components/viewport/ViewportCanvas.tsx`, import and render it inside `<XR>` after `<SceneRoot>`:

```tsx
import { VrHud } from '../../vr/VrHud'
// ...
      <XR store={xrStore}>
        <DesktopControls />
        <Locomotion />
        <SceneRoot>
          <SceneContent />
        </SceneRoot>
        <VrHud />
      </XR>
```

- [ ] **Step 3: Reconcile uikit API**

Run: `cd web && npx tsc -b`. The `Text` imperative ref shape (`setText`) and prop names (`backgroundOpacity`, `pixelSize`, `anchorX`) are from `@react-three/uikit`; if any do not type-check, consult `web/node_modules/@react-three/uikit/readme.md` and adjust. If `Text` does not expose `setText`, fall back to rendering the Points/FPS value from a throttled React state (a `useState` updated by a 100 ms `setInterval`, mirroring `HeaderBar.tsx`). Expected end state: no type errors.

- [ ] **Step 4: In-headset verification of the slice**

On the Quest (`https://<dev-ip>:5173` → Enter VR), confirm:
- the HUD floats in front of you and follows your head,
- connection shows "Connected" against the running bridge/mock,
- Points/FPS update live (~10 Hz) without stutter,
- tapping a Layers chip with the controller ray toggles that layer in the scene,
- the Void/Passthrough switch flips the environment.
Run the mock bridge if not on hardware: `uv run python -m robot_bridge.mock` (per project README), with the dev server pointed at it.

- [ ] **Step 5: Full typecheck, lint, existing tests**

```bash
cd web && npx tsc -b && npm run lint && npx vitest run
```
Expected: clean typecheck, lint passes, all existing + new unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/vr/VrHud.tsx web/src/components/viewport/ViewportCanvas.tsx
git commit -m "feat: core uikit VR HUD — status, points/fps, layers, mode switch"
```

---

## Out of scope (future plans)

These are deliberately deferred per the spec's phasing and are NOT part of this plan:
- Porting the remaining ~12 panels (nav, teleop, IMU, diagnostics, camera feeds) to uikit.
- uPlot graphs rendered as GPU CanvasTextures in VR.
- Hand-tracking gesture polish.
- HTTPS termination on the Jetson deployment (this plan validates via the dev machine's HTTPS over LAN; production serving is a separate deployment task).

## Self-Review notes

- **Spec coverage:** both-modes toggle (Tasks 7–8), uikit VR HUD (Task 8), desktop DOM chrome untouched (Tasks 1,5 parity checks), single repo (all under existing `web/`), locomotion walk+teleport+scale (Task 6), thin slice = cloud+locomotion+mode toggle+minimal HUD (Tasks 6–8), HTTPS-on-Quest usage (Task 2 + Task 7 Step 6). Coordinate Z-up→Y-up fix (Task 4). All spec sections map to a task.
- **Version-API caveats** (Tasks 5/6/8 reconcile steps) are explicit verification steps against the installed package docs, not logic placeholders — @react-three/xr v6 and uikit renamed some APIs and the exact symbols must be confirmed at implementation time.
- **Type consistency:** `useVrStore`, `setWorldScale`/`clampWorldScale`, `Z_UP_TO_Y_UP`, `xrStore`, `SceneContent`, `SceneRoot` names are used identically across tasks.
