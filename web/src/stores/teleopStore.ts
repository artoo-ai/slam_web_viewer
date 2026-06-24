import { create } from 'zustand'

/** Manual-drive state. The joystick/keyboard write a target body twist here and
 *  TeleopPanel streams it to the bridge; `armed` gates all motion so a stray
 *  drag can't drive the robot.
 *
 *  Two limits, both in play:
 *   - ceilVx/ceilWz — the HARD ceiling the bridge advertised in `hello`
 *     (its --teleop-max-vx/wz). The bridge re-clamps to these no matter what.
 *   - maxVx/maxWz — the live EFFECTIVE max the joystick maps full deflection to,
 *     adjustable in the UI within [MIN_MAX, ceil] with no bridge restart.
 *  Until a `hello` arrives we fall back to the deployed defaults (0.5 / 0.6). */

export const DEFAULT_MAX_VX = 0.5 // m/s
export const DEFAULT_MAX_WZ = 0.6 // rad/s
export const MIN_MAX = 0.05

const clampRange = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

interface TeleopState {
  armed: boolean
  /** hard ceiling from the bridge (hello.teleop) — the most the UI may offer */
  ceilVx: number
  ceilWz: number
  /** live effective max the stick maps to (≤ ceiling), m/s and rad/s */
  maxVx: number
  maxWz: number
  /** current target body twist (already scaled), m/s and rad/s */
  vx: number
  wz: number
  arm: () => void
  disarm: () => void
  /** apply the bridge-advertised ceiling; resets the effective max to full */
  setCeiling: (maxVx: number, maxWz: number) => void
  setMaxVx: (v: number) => void
  setMaxWz: (v: number) => void
  /** set the target from a normalized stick vector: nx right+, ny up+ (both -1..1) */
  setVector: (nx: number, ny: number) => void
  /** zero the target (release / stop) without disarming */
  stop: () => void
}

export const useTeleopStore = create<TeleopState>((set) => ({
  armed: false,
  ceilVx: DEFAULT_MAX_VX,
  ceilWz: DEFAULT_MAX_WZ,
  maxVx: DEFAULT_MAX_VX,
  maxWz: DEFAULT_MAX_WZ,
  vx: 0,
  wz: 0,
  arm: () => set({ armed: true }),
  disarm: () => set({ armed: false, vx: 0, wz: 0 }),
  setCeiling: (maxVx, maxWz) =>
    set({
      ceilVx: maxVx,
      ceilWz: maxWz,
      // (re)connect maps full deflection to the whole advertised range; the
      // user can dial down live afterwards
      maxVx: Math.max(MIN_MAX, maxVx),
      maxWz: Math.max(MIN_MAX, maxWz),
    }),
  setMaxVx: (v) => set((s) => ({ maxVx: clampRange(v, MIN_MAX, s.ceilVx) })),
  setMaxWz: (v) => set((s) => ({ maxWz: clampRange(v, MIN_MAX, s.ceilWz) })),
  setVector: (nx, ny) =>
    set((s) => ({
      vx: ny * s.maxVx, // up = forward
      wz: -nx * s.maxWz, // right = clockwise (wz < 0)
    })),
  stop: () => set({ vx: 0, wz: 0 }),
}))
