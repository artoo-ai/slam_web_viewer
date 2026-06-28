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
  setMode: (mode: VrSessionMode) => void
  setEnvironment: (environment: VrEnvironment) => void
  setJoystickMode: (joystickMode: VrJoystickMode) => void
  setViewMode: (viewMode: VrViewMode) => void
  setWorldScale: (scale: number) => void
}

export const useVrStore = create<VrState>((set) => ({
  mode: 'none',
  environment: 'void',
  joystickMode: 'move',
  viewMode: 'free',
  worldScale: 1,
  setMode: (mode) => set({ mode }),
  setEnvironment: (environment) => set({ environment }),
  setJoystickMode: (joystickMode) => set({ joystickMode }),
  setViewMode: (viewMode) => set({ viewMode }),
  setWorldScale: (scale) => set({ worldScale: clampWorldScale(scale) }),
}))
