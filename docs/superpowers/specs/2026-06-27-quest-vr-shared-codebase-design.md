# Meta Quest VR support in one shared codebase — Design

**Date:** 2026-06-27
**Status:** Approved design, pending implementation plan
**Repo:** robot_gui (github.com/artoo-ai/slam_web_viewer)

## Problem

The browser-based SLAM/navigation viewer (React 19 + react-three-fiber 9 + drei 10 +
three 0.184 + Zustand) should also run on a Meta Quest headset, so the operator can
stand inside the point cloud and physically move through it, with the menu/config
panels floating as a HUD that follows them. The hard requirement: **one codebase** —
a change made for the web viewer must also take effect in the VR version without
manual porting between separate code trees.

## Feasibility summary

This is achievable in a single repo with no separate build target and no app-store
packaging. The stack is already WebXR-capable: three.js has first-class WebXR support
and the Meta Quest Browser supports WebXR natively. The *same URL* that serves the
desktop app can drop into an immersive headset session via an in-page "Enter VR"
button. The only genuine architectural wrinkle is that the current menus/panels are
HTML/CSS DOM overlays, and **DOM is not rendered in immersive WebXR** — so the VR HUD
must be rebuilt as in-scene 3D panels. That HUD layer is the only part that is
authored twice; everything beneath it is single-source.

## Decisions (from brainstorming, 2026-06-27)

- **Experience:** support BOTH full-VR (dark void, cloud floats around you) AND
  passthrough mixed reality (Quest cameras show the real room with cloud + HUD
  overlaid), switchable at runtime.
- **VR HUD technology:** `@react-three/uikit` — flexbox UI rendered as real 3D
  geometry inside the scene, so panels are visible and interactable in immersive mode.
- **Desktop HUD:** unchanged. Keep the existing battle-tested HTML/CSS + uPlot DOM
  chrome on desktop. uikit is used **only** for VR. Rationale: the desktop DOM path is
  pixel-perfect and effectively free for continuously-updating text/graphs, whereas
  uikit text/graph updates cost a Yoga relayout + glyph regen (and uPlot graphs must
  become GPU CanvasTextures in VR). No reason to take that cost on a screen where DOM
  excels. Both HUDs read the same Zustand stores, so data/logic is shared even though
  panel *layout* exists in two forms.
- **Repo:** single repo, one codebase. VR lives as additional components + an opt-in
  entry point in the same `src/`. No cross-repo syncing, ever.
- **Locomotion:** room-scale walking (free) + controller point-and-teleport to jump
  across the map + two-handed grab to scale/rotate the whole cloud (shrink to tabletop
  or blow up to 1:1 and walk inside).
- **First slice:** thin vertical slice — cloud + locomotion + void/passthrough toggle +
  a minimal core HUD — to prove the architecture end-to-end in the headset before
  porting the rest of the ~15 panels.

## Architecture — three layers, only the top one forks

```
┌─ SHARED (100% reused, zero forking) ──────────────────────────┐
│  transport/ · stores/ (Zustand) · types/channels · protocol   │
│  decoder.worker · hooks · tts · config                        │
└───────────────────────────────────────────────────────────────┘
┌─ SHARED SCENE (reused as-is) ─────────────────────────────────┐
│  <SceneContent> = every layer currently inside <Canvas>:      │
│  PointCloud, ScanMain/Low, Depth, Map, Trajectory, Pose,      │
│  OccupancyGrid×3, Path, Goal, ObjectMarkers, ViewportBridge   │
└───────────────────────────────────────────────────────────────┘
┌─ SHELL (the ONLY fork) ───────────────────────────────────────┐
│  Desktop:  Canvas + OrbitControls + DOM chrome (unchanged)    │
│  VR:       Canvas + <XR> + locomotion + uikit HUD in-scene    │
└───────────────────────────────────────────────────────────────┘
```

### Keystone refactor

Extract everything currently inside `<Canvas>` in
`web/src/components/viewport/ViewportCanvas.tsx` (lines 28–53: the layers, overlays and
`ViewportBridge`) into a single `<SceneContent>` component — **excluding** the
desktop-only `OrbitControls` and the camera prop. Then:

- `ViewportCanvas.tsx` (desktop) → `<Canvas><OrbitControls/><SceneContent/></Canvas>` —
  visually and behaviorally unchanged.
- `VRCanvas.tsx` (new) → `<Canvas><XR store={…}><Locomotion/><SceneContent/><VrHud/></XR></Canvas>`.

Because both shells render the *same* `<SceneContent>`, any new 3D layer added later
appears in both automatically. This is the mechanism that delivers "change once, works
in both" for the 3D world.

## Libraries to add

All from pmndrs (same family as the existing fiber/drei dependencies):

- **`@react-three/xr`** (v6) — WebXR session management, controllers, hands, teleport,
  the `<XR>` wrapper and `createXRStore()`. Provides the immersive session the Quest
  browser enters.
- **`@react-three/uikit`** (+ `@react-three/uikit-default`) — in-scene HUD panels, VR only.

No build-system change and no new repo. Exact version compatibility with the pinned
fiber 9 / drei 10 / three 0.184 stack will be verified during plan-writing.

## VR-specific pieces (new, under `web/src/vr/`)

- **Entry point.** A DOM "Enter VR" / "Enter Passthrough" button, rendered only when
  `navigator.xr` is present. Desktop app remains the default; VR is opt-in from the
  same page and the same URL.
- **Coordinate fix.** The world is REP-103 **Z-up**; WebXR player space is **Y-up**.
  In the VR shell, `<SceneContent>` is wrapped in a group rotated −90° about X so the
  map's floor aligns with the operator's real floor. Desktop is unaffected.
- **Locomotion (`Locomotion.tsx`).** Room-scale walking (free) + controller teleport +
  two-handed grab to scale/rotate, all acting on an `XROrigin` via `@react-three/xr`
  helpers.
- **Void ↔ passthrough toggle.** "Void VR" = an `immersive-vr` session with the dark
  background; "Passthrough" = an `immersive-ar` session showing the real room.
  Realistically two session entries (a VR button and an AR button) plus an in-HUD
  switch; the smoothest UX is confirmed during plan-writing.
- **`VrHud.tsx`.** The floating uikit HUD, attached to the camera so it follows the
  operator. For the first slice it carries only the core controls below.

## First shipped slice (thin vertical slice)

**Goal:** stand in the map on the Quest, move through it, with a minimal working HUD —
proving the whole architecture end-to-end.

Included:
- Full `<SceneContent>` (all existing 3D layers — free, since shared).
- Locomotion: walk + teleport + grab-to-scale.
- Void/passthrough toggle.
- A small uikit HUD: connection status + a couple of key metrics (points / FPS), the
  **Layers** toggles (reusing `layersStore`), and the mode toggle.

Explicitly deferred to later phases:
- Porting the other ~12 panels (nav, teleop, IMU, diagnostics, camera feeds).
- uPlot graphs rendered as GPU CanvasTextures.
- Hand-tracking polish.

## Running it on the Quest (usage)

Mental model: **same URL → flat page with an "Enter VR" button → tap → you're inside.**
No app install, nothing from the Meta Store.

1. Open the **Meta Quest Browser** and navigate to the app URL (same as desktop). The
   normal 2D app appears as a flat window floating in space.
2. The page shows an **"Enter VR"** button (and "Enter Passthrough"). This is an in-app
   button that calls `navigator.xr.requestSession(...)` — not browser fullscreen.
3. **Tap it** → the flat window disappears and you drop *into* the 3D scene:
   head-tracked, controllers active, HUD floating with you, standing in the point cloud.
4. **Exit** with the Meta/Oculus button or a "Leave VR" control to return to the flat page.

Why a button and not fullscreen: browser fullscreen only makes the flat 2D window fill
the view (no head tracking, no walking). Immersive WebXR is the real thing — stereo
rendering, room-scale tracking — and the browser requires an explicit user tap to start
it.

### Prerequisite: HTTPS

WebXR refuses to start over plain HTTP (only HTTPS or `localhost` qualify). Therefore:
- The Vite dev server needs a LAN-accessible HTTPS cert so the Quest browser can load it
  from the dev machine.
- The robot/Jetson deployment needs HTTPS too.

This is the one piece of ops the VR path requires that desktop did not. It is included
in the implementation plan.

## Migration answer

No separate repo, and no migrating changes between code trees. Shared logic and the
entire 3D scene live in `web/src/` and are imported by both shells. The only code that
exists twice is **panel layout** (DOM on desktop, uikit in VR), and only for panels
deliberately brought into VR. Everything below the panel layer is single-source.

## Phasing (each its own future spec/plan)

1. **Refactor:** extract `SceneContent` out of `ViewportCanvas` (no behavior change;
   desktop still works).
2. **VR shell + locomotion + void/passthrough**, no HUD — "I'm standing in my map."
3. **Core uikit HUD** (the slice above).
4. Port remaining panels to uikit incrementally; graphs-as-texture; hand-tracking.

## Risks / open items (to resolve during plan-writing)

- Exact version compatibility of `@react-three/xr` v6 and `@react-three/uikit` with the
  pinned fiber 9 / drei 10 / three 0.184 stack.
- Smoothest void↔passthrough switching UX (single session vs two session entries).
- HTTPS cert approach for dev (LAN) and for the Jetson deployment.
- uikit text/graph update throttling discipline (~10 Hz, fixed-width numeric fields,
  imperative updates) to keep VR framerate — mirrors the existing "scan/pose bypass
  React via module feeds polled in useFrame" pattern.

## Dev note: localhost VR emulator

`createXRStore({ hand: true, controller: true })` leaves the IWER Quest-3 emulator
enabled by default. This emulator auto-activates **only on `localhost`** when no real
WebXR device is detected, injecting a fake headset so the full VR flow (Enter VR, HUD,
locomotion, mode switching) can be tested in a desktop browser without a physical
headset. This is intentionally kept for headset-free dev iteration and is not a desktop
regression. Accessing the app over a LAN IP or HTTPS on a real Quest is entirely
unaffected — the emulator stays dormant when a real WebXR implementation is present.
