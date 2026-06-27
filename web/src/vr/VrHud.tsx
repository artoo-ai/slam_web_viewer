import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useFrame } from '@react-three/fiber'
import { Root, Container, Text } from '@react-three/uikit'
import { Euler, Quaternion, Vector3, type Group } from 'three'
import { useConnectionStore } from '../stores/connectionStore'
import { useLayersStore, type LayerVisibility } from '../stores/layersStore'
import { useVrStore } from '../stores/vrModeStore'
import { useTeleopStore } from '../stores/teleopStore'
import { mapFeed } from '../stores/mapFeed'
import { scanFeed } from '../stores/scanFeed'
import { fpsMeter } from '../lib/viewportRefs'

/** Floating VR HUD (session-only). Parented to a group we lazy yaw-follow ~1.2m
 *  in front of the operator. Styled as a compact instrument panel — see the
 *  palette + Chip/Section helpers below. */

const LAYERS: { key: keyof LayerVisibility; label: string }[] = [
  { key: 'scan', label: 'Scan' },
  { key: 'map_points', label: 'Map' },
  { key: 'trajectory', label: 'Trail' },
  { key: 'map', label: 'Grid' },
  { key: 'costmap_global', label: 'Cost G' },
  { key: 'costmap_local', label: 'Cost L' },
  { key: 'path', label: 'Path' },
]

// Instrument-panel palette (cohesive with the SJY desktop chrome).
const C = {
  panel: '#0d1522',
  panelBorder: '#27374f',
  divider: '#1c2942',
  text: '#eaf1fb',
  textDim: '#9aadc6',
  label: '#5f7491',
  accent: '#3b82f6',
  accentHover: '#5b9bff',
  chip: '#162232',
  chipBorder: '#2a3a52',
  chipHover: '#1d2c40',
  chipBorderHover: '#3a4d6b',
  live: '#3ddc97',
  down: '#e7794b',
  alert: '#e23b3b',
  alertHover: '#f24c4c',
}

// Lazy yaw-follow placement: panel stays UPRIGHT (yaw only — no pitch/roll tilt),
// sits a comfortable distance ahead and slightly below eye line, and trails head
// turns smoothly so it holds still long enough to aim the controller ray at it.
const HUD_DISTANCE = 1.2 // m in front of the head
const HUD_DROP = 0.18 // m below eye line
const FOLLOW_K = 3.5 // follow stiffness; higher = snappier
const _camEuler = new Euler(0, 0, 0, 'YXZ')
const _targetPos = new Vector3()
const _targetQuat = new Quaternion()
const _yAxis = new Vector3(0, 1, 0)

// uikit 1.0.74 has no padding/borderRadius shorthands — expand them via helpers.
const pad = (x: number, y: number) =>
  ({ paddingLeft: x, paddingRight: x, paddingTop: y, paddingBottom: y }) as const
const radius = (r: number) =>
  ({
    borderTopLeftRadius: r,
    borderTopRightRadius: r,
    borderBottomLeftRadius: r,
    borderBottomRightRadius: r,
  }) as const

/** A pill toggle/button with border + hover/active states. `tone` 'alert' is the
 *  red Arm control; `grow` makes paired chips share the row width evenly. */
function Chip({
  label,
  active,
  onClick,
  tone = 'accent',
  grow = false,
}: {
  label: string
  active: boolean
  onClick: () => void
  tone?: 'accent' | 'alert'
  grow?: boolean
}) {
  const on = tone === 'alert' ? C.alert : C.accent
  const onHover = tone === 'alert' ? C.alertHover : C.accentHover
  return (
    <Container
      flexGrow={grow ? 1 : 0}
      justifyContent="center"
      {...pad(13, 8)}
      {...radius(8)}
      borderWidth={1}
      borderColor={active ? on : C.chipBorder}
      backgroundColor={active ? on : C.chip}
      cursor="pointer"
      hover={{ backgroundColor: active ? onHover : C.chipHover, borderColor: active ? onHover : C.chipBorderHover }}
      onClick={onClick}
    >
      <Text fontSize={12.5} letterSpacing={0.3} color={active ? '#ffffff' : C.textDim}>
        {label}
      </Text>
    </Container>
  )
}

/** A labelled group: uppercase tracked label over its controls. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Container flexDirection="column" gapRow={8}>
      <Text fontSize={10} letterSpacing={2} color={C.label}>
        {label}
      </Text>
      {children}
    </Container>
  )
}

const Row = ({ children }: { children: ReactNode }) => (
  <Container flexDirection="row" gapColumn={8}>
    {children}
  </Container>
)

export function VrHud() {
  const mode = useVrStore((s) => s.mode)
  const environment = useVrStore((s) => s.environment)
  const setEnvironment = useVrStore((s) => s.setEnvironment)
  const joystickMode = useVrStore((s) => s.joystickMode)
  const setJoystickMode = useVrStore((s) => s.setJoystickMode)
  const viewMode = useVrStore((s) => s.viewMode)
  const setViewMode = useVrStore((s) => s.setViewMode)
  const status = useConnectionStore((s) => s.status)
  const hasTeleop = useConnectionStore((s) => s.hello?.channels.includes('teleop') ?? false)
  const armed = useTeleopStore((s) => s.armed)
  const layers = useLayersStore()
  const toggle = useLayersStore((s) => s.toggle)

  // Switching to Move always disarms (and the robot halts) so we never leave the
  // robot live after stepping away from driving.
  const selectMove = () => {
    useTeleopStore.getState().disarm()
    setJoystickMode('move')
  }

  // setInterval fallback for Points/FPS at ~10 Hz (imperative setText not available
  // in uikit 1.0.74). Only runs while a session is active.
  const [scene, setScene] = useState({ pts: 0, fps: 0 })
  useEffect(() => {
    if (mode === 'none') return
    const t = setInterval(() => setScene({ pts: mapFeed.count + scanFeed.count, fps: fpsMeter.fps }), 100)
    return () => clearInterval(t)
  }, [mode])

  const hudRef = useRef<Group>(null)
  const placed = useRef(false)

  // Lazy yaw-follow: target a point ahead of the head along the head's YAW only
  // (ignoring pitch/roll, so the panel never tilts), then ease position + yaw
  // toward it. The easing is what lets you aim at a button without it dodging.
  useFrame((state, delta) => {
    if (mode === 'none') {
      placed.current = false
      return
    }
    const hud = hudRef.current
    if (!hud) return
    const cam = state.camera
    _camEuler.setFromQuaternion(cam.quaternion, 'YXZ')
    const yaw = _camEuler.y
    _targetPos.set(
      cam.position.x - Math.sin(yaw) * HUD_DISTANCE,
      cam.position.y - HUD_DROP,
      cam.position.z - Math.cos(yaw) * HUD_DISTANCE,
    )
    _targetQuat.setFromAxisAngle(_yAxis, yaw)
    if (!placed.current) {
      hud.position.copy(_targetPos)
      hud.quaternion.copy(_targetQuat)
      placed.current = true
    } else {
      const alpha = 1 - Math.exp(-FOLLOW_K * delta)
      hud.position.lerp(_targetPos, alpha)
      hud.quaternion.slerp(_targetQuat, alpha)
    }
  })

  if (mode === 'none') return null

  const connected = status === 'open'

  return (
    <group ref={hudRef}>
      <Root pixelSize={0.0016} anchorX="center" anchorY="center">
        <Container
          flexDirection="column"
          gapRow={15}
          {...pad(17, 16)}
          {...radius(14)}
          borderWidth={1.5}
          borderColor={C.panelBorder}
          backgroundColor={C.panel}
          width={460}
        >
          {/* Header: accent dot · wordmark · live status */}
          <Container flexDirection="row" alignItems="center" gapColumn={9}>
            <Container width={8} height={8} {...radius(4)} backgroundColor={C.accent} />
            <Text fontSize={15} letterSpacing={3} color={C.text}>ROBOT GUI</Text>
            <Container flexGrow={1} />
            <Container width={7} height={7} {...radius(4)} backgroundColor={connected ? C.live : C.down} />
            <Text fontSize={11} letterSpacing={1} color={connected ? C.live : C.down}>
              {connected ? 'LIVE' : status.toUpperCase()}
            </Text>
          </Container>

          <Container height={1} backgroundColor={C.divider} />

          {/* Metrics: points · fps */}
          <Container flexDirection="row" alignItems="center" gapColumn={7}>
            <Text fontSize={10} letterSpacing={1.5} color={C.label}>POINTS</Text>
            <Text fontSize={15} color={C.text}>{scene.pts.toLocaleString()}</Text>
            <Container width={3} height={3} {...radius(2)} backgroundColor={C.label} />
            <Text fontSize={15} color={C.text}>{scene.fps}</Text>
            <Text fontSize={10} letterSpacing={1.5} color={C.label}>FPS</Text>
          </Container>

          <Section label="ENVIRONMENT">
            <Row>
              <Chip label="Void" active={environment === 'void'} onClick={() => setEnvironment('void')} grow />
              <Chip
                label="Passthrough"
                active={environment === 'passthrough'}
                onClick={() => setEnvironment('passthrough')}
                grow
              />
            </Row>
          </Section>

          <Section label="VIEW">
            <Row>
              <Chip label="Free" active={viewMode === 'free'} onClick={() => setViewMode('free')} grow />
              <Chip label="Robot POV" active={viewMode === 'robot'} onClick={() => setViewMode('robot')} grow />
            </Row>
          </Section>

          <Section label="LAYERS">
            <Container flexDirection="row" flexWrap="wrap" gapRow={8} gapColumn={8}>
              {LAYERS.map(({ key, label }) => (
                <Chip key={key} label={label} active={layers[key]} onClick={() => toggle(key)} />
              ))}
            </Container>
          </Section>

          {hasTeleop && (
            <Section label="JOYSTICK">
              <Row>
                <Chip label="Move me" active={joystickMode === 'move'} onClick={selectMove} grow />
                <Chip label="Drive robot" active={joystickMode === 'drive'} onClick={() => setJoystickMode('drive')} grow />
                {joystickMode === 'drive' && (
                  <Chip
                    label={armed ? 'STOP' : 'ARM'}
                    active={armed}
                    tone="alert"
                    onClick={() => (armed ? useTeleopStore.getState().disarm() : useTeleopStore.getState().arm())}
                  />
                )}
              </Row>
            </Section>
          )}
        </Container>
      </Root>
    </group>
  )
}
