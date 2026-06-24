import { create } from 'zustand'

/** Manual-drive state. The joystick/keyboard write a target body twist here and
 *  TeleopPanel streams it to the bridge; `armed` gates all motion so a stray
 *  drag can't drive the robot. Speeds are clamped again robot-side (the bridge
 *  is the authority); these caps just scale the UI and match the deployed maxima
 *  (0.5 m/s linear, 0.6 rad/s angular). */

export const TELEOP_MAX_VX = 0.5 // m/s
export const TELEOP_MAX_WZ = 0.6 // rad/s

interface TeleopState {
  armed: boolean
  /** 0.1–1.0 multiplier on the max speeds — a soft governor */
  scale: number
  /** current target body twist (already scaled), m/s and rad/s */
  vx: number
  wz: number
  arm: () => void
  disarm: () => void
  setScale: (scale: number) => void
  /** set the target from a normalized stick vector: nx right+, ny up+ (both -1..1) */
  setVector: (nx: number, ny: number) => void
  /** zero the target (release / stop) without disarming */
  stop: () => void
}

export const useTeleopStore = create<TeleopState>((set) => ({
  armed: false,
  scale: 0.6,
  vx: 0,
  wz: 0,
  arm: () => set({ armed: true }),
  disarm: () => set({ armed: false, vx: 0, wz: 0 }),
  setScale: (scale) => set({ scale: Math.max(0.1, Math.min(1, scale)) }),
  setVector: (nx, ny) =>
    set((s) => ({
      vx: ny * TELEOP_MAX_VX * s.scale, // up = forward
      wz: -nx * TELEOP_MAX_WZ * s.scale, // right = clockwise (wz < 0)
    })),
  stop: () => set({ vx: 0, wz: 0 }),
}))
