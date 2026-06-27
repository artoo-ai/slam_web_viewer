import { create } from 'zustand'

export type VrSessionMode = 'none' | 'vr' | 'ar'

/** Void = opaque backdrop hides the real room; passthrough = Quest cameras show
 *  through. WebXR can't hot-swap session types, so we run ONE immersive-ar session
 *  and toggle this at runtime instead — an opaque backdrop sphere when 'void'. */
export type VrEnvironment = 'void' | 'passthrough'

/** What the left thumbstick does: 'move' flies you through the world (default),
 *  'drive' streams cmd_vel to teleoperate the robot (gated on an Arm press). */
export type VrJoystickMode = 'move' | 'drive'

/** Viewpoint: 'free' lets you move yourself anywhere; 'robot' locks your
 *  viewpoint to the robot's live pose so you ride along and see the map from
 *  where the robot is. */
export type VrViewMode = 'free' | 'robot'

export const MIN_WORLD_SCALE = 0.02
export const MAX_WORLD_SCALE = 5

/** Uniform scale of the whole cloud, set by the two-handed grab gesture. */
export function clampWorldScale(scale: number): number {
  return Math.min(MAX_WORLD_SCALE, Math.max(MIN_WORLD_SCALE, scale))
}

interface VrState {
  mode: VrSessionMode
  environment: VrEnvironment
  joystickMode: VrJoystickMode
  viewMode: VrViewMode
  worldScale: number
  /** whether the <XR> subtree is mounted. The flat desktop page keeps this false
   *  because mounting <XR> with no session freezes the normal render loop; we
   *  mount it only while entering/in VR. */
  xrActive: boolean
  /** a pending session entry consumed once <XR> has mounted (so requestSession
   *  runs after the WebXR manager is connected, still within user activation) */
  pendingEnter: { ar: boolean } | null
  setMode: (mode: VrSessionMode) => void
  setEnvironment: (environment: VrEnvironment) => void
  setJoystickMode: (joystickMode: VrJoystickMode) => void
  setViewMode: (viewMode: VrViewMode) => void
  setWorldScale: (scale: number) => void
  /** mount <XR> and queue a session entry (called from the Enter VR/AR buttons) */
  requestEnter: (environment: VrEnvironment, ar: boolean) => void
  /** read & clear the pending entry (called by XrAutoEnter on mount) */
  consumePending: () => { ar: boolean } | null
  /** unmount <XR> and restore flat rendering (on session end or entry failure) */
  exitXr: () => void
}

export const useVrStore = create<VrState>((set, get) => ({
  mode: 'none',
  environment: 'void',
  joystickMode: 'move',
  viewMode: 'free',
  worldScale: 1,
  xrActive: false,
  pendingEnter: null,
  setMode: (mode) => set({ mode }),
  setEnvironment: (environment) => set({ environment }),
  setJoystickMode: (joystickMode) => set({ joystickMode }),
  setViewMode: (viewMode) => set({ viewMode }),
  setWorldScale: (scale) => set({ worldScale: clampWorldScale(scale) }),
  requestEnter: (environment, ar) => set({ environment, pendingEnter: { ar }, xrActive: true }),
  consumePending: () => {
    const p = get().pendingEnter
    set({ pendingEnter: null })
    return p
  },
  exitXr: () => set({ xrActive: false, pendingEnter: null }),
}))
