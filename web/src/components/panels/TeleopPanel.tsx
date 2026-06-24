import { useEffect, useRef, useState } from 'react'
import { connection } from '../../lib/transport/connection'
import { useConnectionStore } from '../../stores/connectionStore'
import { useLayersStore } from '../../stores/layersStore'
import { useTeleopStore, MIN_MAX } from '../../stores/teleopStore'
import './panels.css'

/** Manual-drive joystick. Drag the pad (or hold WASD / arrow keys) to stream a
 *  body twist to the bridge as `cmd_vel`. Safety:
 *   - inert until ARMED (a stray drag can't drive the robot);
 *   - releasing the pad / keys zeroes the command immediately;
 *   - disconnect or window-blur auto-disarms;
 *   - the stream stops on disarm — the bridge deadman then halts the robot.
 *  The bridge clamps to its own maxima; this UI is not the safety authority. */

const SEND_HZ = 15
const KEY_VEC: Record<string, [number, number]> = {
  w: [0, 1], ArrowUp: [0, 1],
  s: [0, -1], ArrowDown: [0, -1],
  a: [-1, 0], ArrowLeft: [-1, 0],
  d: [1, 0], ArrowRight: [1, 0],
}

export function TeleopPanel() {
  const visible = useLayersStore((s) => s.teleop)
  const hasTeleop = useConnectionStore(
    (s) => s.hello?.channels.includes('teleop') ?? false,
  )
  const open = useConnectionStore((s) => s.status === 'open')
  const teleopCaps = useConnectionStore((s) => s.hello?.teleop)

  const armed = useTeleopStore((s) => s.armed)
  const vx = useTeleopStore((s) => s.vx)
  const wz = useTeleopStore((s) => s.wz)
  const maxVx = useTeleopStore((s) => s.maxVx)
  const maxWz = useTeleopStore((s) => s.maxWz)
  const ceilVx = useTeleopStore((s) => s.ceilVx)
  const ceilWz = useTeleopStore((s) => s.ceilWz)

  // adopt the bridge-advertised hard ceiling when hello arrives
  useEffect(() => {
    if (teleopCaps) useTeleopStore.getState().setCeiling(teleopCaps.max_vx, teleopCaps.max_wz)
  }, [teleopCaps])

  const padRef = useRef<HTMLDivElement>(null)
  const [knob, setKnob] = useState({ x: 0, y: 0 }) // px offset from pad center
  const dragging = useRef(false)
  const keys = useRef(new Set<string>())

  // --- stream the current twist while armed; stop (with a final zero) otherwise
  useEffect(() => {
    if (!armed) return
    const tick = () => {
      const s = useTeleopStore.getState()
      connection.send({ cmd: 'cmd_vel', vx: round(s.vx), wz: round(s.wz) })
    }
    tick()
    const timer = setInterval(tick, 1000 / SEND_HZ)
    return () => {
      clearInterval(timer)
      // a couple of explicit stops so the robot halts the instant we disarm,
      // not only when the bridge deadman expires
      connection.send({ cmd: 'cmd_vel', vx: 0, wz: 0 })
      connection.send({ cmd: 'cmd_vel', vx: 0, wz: 0 })
    }
  }, [armed])

  // --- safety: drop out of armed if the link closes
  useEffect(() => {
    if (!open && armed) useTeleopStore.getState().disarm()
  }, [open, armed])

  // --- keyboard drive (only while armed)
  useEffect(() => {
    if (!armed) return
    const pressed = keys.current // stable ref identity for the effect's lifetime
    const recompute = () => {
      let nx = 0
      let ny = 0
      for (const k of pressed) {
        const v = KEY_VEC[k]
        if (v) {
          nx += v[0]
          ny += v[1]
        }
      }
      nx = clamp(nx, -1, 1)
      ny = clamp(ny, -1, 1)
      if (!dragging.current) useTeleopStore.getState().setVector(nx, ny)
    }
    const onDown = (e: KeyboardEvent) => {
      if (!(e.key in KEY_VEC) || e.repeat) return
      e.preventDefault()
      pressed.add(e.key)
      recompute()
    }
    const onUp = (e: KeyboardEvent) => {
      if (!pressed.delete(e.key)) return
      recompute()
    }
    // alt-tabbing away can swallow keyup — release everything on blur
    const onBlur = () => {
      pressed.clear()
      if (!dragging.current) useTeleopStore.getState().stop()
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
      pressed.clear()
    }
  }, [armed])

  if (!visible || !hasTeleop) return null

  const onPointerDown = (e: React.PointerEvent) => {
    if (!armed) return
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    moveKnob(e.clientX, e.clientY)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return
    moveKnob(e.clientX, e.clientY)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    setKnob({ x: 0, y: 0 })
    useTeleopStore.getState().stop()
  }

  const moveKnob = (clientX: number, clientY: number) => {
    const el = padRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const radius = r.width / 2
    let dx = clientX - (r.left + radius)
    let dy = clientY - (r.top + radius)
    const mag = Math.hypot(dx, dy)
    if (mag > radius) {
      dx = (dx / mag) * radius
      dy = (dy / mag) * radius
    }
    setKnob({ x: dx, y: dy })
    useTeleopStore.getState().setVector(dx / radius, -dy / radius) // screen y is down
  }

  return (
    <section className="teleop">
      <header className="teleop-head">
        <span>Manual Drive</span>
        <span className={armed ? 'teleop-armed' : 'teleop-safe'}>
          {armed ? 'ARMED' : 'safe'}
        </span>
      </header>

      <div
        ref={padRef}
        className={`teleop-pad${armed ? '' : ' teleop-pad-off'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="teleop-crosshair-h" />
        <div className="teleop-crosshair-v" />
        <div
          className="teleop-knob"
          style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }}
        />
      </div>

      <div className="teleop-readout">
        <span>vx {vx.toFixed(2)} m/s</span>
        <span>wz {wz.toFixed(2)} rad/s</span>
      </div>

      <div className="teleop-slider"
           title="Top forward speed at full stick, up to the bridge ceiling.">
        <span>fwd</span>
        <input
          type="range"
          min={MIN_MAX}
          max={ceilVx}
          step={0.05}
          value={maxVx}
          onChange={(e) => useTeleopStore.getState().setMaxVx(Number(e.target.value))}
        />
        <span className="teleop-pct">{maxVx.toFixed(2)}</span>
      </div>

      <div className="teleop-slider"
           title="Top turn rate at full stick, up to the bridge ceiling. Raise the
ceiling with the bridge's --teleop-max-wz; this slider tunes within it live.">
        <span>turn</span>
        <input
          type="range"
          min={MIN_MAX}
          max={ceilWz}
          step={0.05}
          value={maxWz}
          onChange={(e) => useTeleopStore.getState().setMaxWz(Number(e.target.value))}
        />
        <span className="teleop-pct">{maxWz.toFixed(2)}</span>
      </div>

      <div className="teleop-row">
        {armed ? (
          <button
            className="teleop-btn teleop-estop"
            onClick={() => useTeleopStore.getState().disarm()}
          >
            ■ STOP
          </button>
        ) : (
          <button
            className="teleop-btn teleop-arm"
            disabled={!open}
            onClick={() => useTeleopStore.getState().arm()}
          >
            Arm
          </button>
        )}
      </div>
      <div className="teleop-hint">
        {armed
          ? 'drag pad or hold W A S D / arrows'
          : `ceiling ${ceilVx.toFixed(1)} m/s · ${ceilWz.toFixed(1)} rad/s`}
      </div>
    </section>
  )
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
