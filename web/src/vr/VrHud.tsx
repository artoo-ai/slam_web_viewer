import { useEffect, useRef, useState } from 'react'
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

/** Floating VR HUD (session-only). Parented to a group we lock ~1.2m in front of
 *  the camera each frame so it follows the operator. Points/FPS are updated via
 *  setInterval at ~10 Hz (not per-frame) to keep VR framerate stable. */
const HUD_LAYERS: (keyof LayerVisibility)[] = [
  'scan', 'map_points', 'trajectory', 'map', 'costmap_global', 'costmap_local', 'path',
]

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

// Radius applied to all four corners of a container.
function borderProps(r: number) {
  return {
    borderTopLeftRadius: r,
    borderTopRightRadius: r,
    borderBottomLeftRadius: r,
    borderBottomRightRadius: r,
  } as const
}

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

  // setInterval fallback for Points/FPS at ~10 Hz (imperative setText not available in uikit 1.0.74)
  // Only runs while a session is active; re-subscribes on session enter/exit.
  const [scene, setScene] = useState({ pts: 0, fps: 0 })
  useEffect(() => {
    if (mode === 'none') return
    const t = setInterval(
      () => setScene({ pts: mapFeed.count + scanFeed.count, fps: fpsMeter.fps }),
      100,
    )
    return () => clearInterval(t)
  }, [mode])

  const hudRef = useRef<Group>(null)
  const placed = useRef(false)

  // Lazy yaw-follow: target a point ahead of the head along the head's YAW only
  // (ignoring pitch/roll, so the panel never tilts), then ease position + yaw
  // toward it. The easing is what lets you aim at a button without it dodging.
  // Snaps into place on the first frame of a session; eased thereafter.
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
    const forwardX = -Math.sin(yaw)
    const forwardZ = -Math.cos(yaw)
    _targetPos.set(
      cam.position.x + forwardX * HUD_DISTANCE,
      cam.position.y - HUD_DROP,
      cam.position.z + forwardZ * HUD_DISTANCE,
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

  return (
    <group ref={hudRef}>
      {/* pixelSize, anchorX, anchorY confirmed in @react-three/uikit 1.0.74 */}
      <Root pixelSize={0.0016} anchorX="center" anchorY="center">
        {/*
          API deviations from brief applied:
          - `gap` → `gapColumn` / `gapRow` (no gap shorthand)
          - `padding` → individual sides (paddingTop/Left/Right/Bottom)
          - `borderRadius` → four individual corner props via borderProps()
          - `backgroundOpacity` → dropped (no such prop; use `opacity` on the group if needed)
          - `paddingX`/`paddingY` → paddingLeft+paddingRight / paddingTop+paddingBottom
        */}
        <Container
          flexDirection="column"
          gapRow={8}
          paddingTop={14}
          paddingLeft={14}
          paddingRight={14}
          paddingBottom={14}
          {...borderProps(10)}
          backgroundColor="#141d2b"
          width={420}
        >
          <Text fontSize={20} color="#e8eef7">Robot GUI · VR</Text>
          <Text fontSize={14} color={status === 'open' ? '#5fd08a' : '#d0825f'}>
            {status === 'open' ? 'Connected' : status}
          </Text>
          <Text fontSize={14} color="#9fb2cc">
            {`Points ${scene.pts.toLocaleString()}  ·  ${scene.fps} FPS`}
          </Text>

          <Text fontSize={13} color="#7f93ad">Layers</Text>
          {/* flexWrap value "wrap" confirmed valid in uikit 1.0.74 */}
          <Container flexDirection="row" flexWrap="wrap" gapRow={6} gapColumn={6}>
            {HUD_LAYERS.map((key) => (
              <Container
                key={key}
                paddingLeft={10}
                paddingRight={10}
                paddingTop={6}
                paddingBottom={6}
                {...borderProps(6)}
                backgroundColor={layers[key] ? '#2f6df0' : '#27344a'}
                onClick={() => toggle(key)}
              >
                <Text fontSize={12} color="#e8eef7">{key}</Text>
              </Container>
            ))}
          </Container>

          {/* Instant void ↔ passthrough toggle: flips the VoidBackdrop, no session
              re-entry (WebXR can't hot-swap session types). */}
          <Container flexDirection="row" gapColumn={8}>
            <Container
              paddingLeft={12}
              paddingRight={12}
              paddingTop={8}
              paddingBottom={8}
              {...borderProps(6)}
              backgroundColor={environment === 'void' ? '#2f6df0' : '#27344a'}
              onClick={() => setEnvironment('void')}
            >
              <Text fontSize={13} color="#e8eef7">Void</Text>
            </Container>
            <Container
              paddingLeft={12}
              paddingRight={12}
              paddingTop={8}
              paddingBottom={8}
              {...borderProps(6)}
              backgroundColor={environment === 'passthrough' ? '#2f6df0' : '#27344a'}
              onClick={() => setEnvironment('passthrough')}
            >
              <Text fontSize={13} color="#e8eef7">Passthrough</Text>
            </Container>
          </Container>

          {/* Viewpoint: Free moves you anywhere; Robot POV locks your view to the
              robot's live pose so you ride along and see what it sees. */}
          <Text fontSize={13} color="#7f93ad">View</Text>
          <Container flexDirection="row" gapColumn={8}>
            <Container
              paddingLeft={12}
              paddingRight={12}
              paddingTop={8}
              paddingBottom={8}
              {...borderProps(6)}
              backgroundColor={viewMode === 'free' ? '#2f6df0' : '#27344a'}
              onClick={() => setViewMode('free')}
            >
              <Text fontSize={13} color="#e8eef7">Free</Text>
            </Container>
            <Container
              paddingLeft={12}
              paddingRight={12}
              paddingTop={8}
              paddingBottom={8}
              {...borderProps(6)}
              backgroundColor={viewMode === 'robot' ? '#2f6df0' : '#27344a'}
              onClick={() => setViewMode('robot')}
            >
              <Text fontSize={13} color="#e8eef7">Robot POV</Text>
            </Container>
          </Container>

          {/* Joystick mode: Move flies you through the world; Drive teleoperates the
              robot (left stick = cmd_vel), shown only when the bridge advertises
              teleop. Drive requires an explicit Arm; the robot halts on disarm. */}
          {hasTeleop && (
            <>
              <Text fontSize={13} color="#7f93ad">Joystick</Text>
              <Container flexDirection="row" gapColumn={8}>
                <Container
                  paddingLeft={12}
                  paddingRight={12}
                  paddingTop={8}
                  paddingBottom={8}
                  {...borderProps(6)}
                  backgroundColor={joystickMode === 'move' ? '#2f6df0' : '#27344a'}
                  onClick={selectMove}
                >
                  <Text fontSize={13} color="#e8eef7">Move me</Text>
                </Container>
                <Container
                  paddingLeft={12}
                  paddingRight={12}
                  paddingTop={8}
                  paddingBottom={8}
                  {...borderProps(6)}
                  backgroundColor={joystickMode === 'drive' ? '#2f6df0' : '#27344a'}
                  onClick={() => setJoystickMode('drive')}
                >
                  <Text fontSize={13} color="#e8eef7">Drive robot</Text>
                </Container>
                {joystickMode === 'drive' && (
                  <Container
                    paddingLeft={12}
                    paddingRight={12}
                    paddingTop={8}
                    paddingBottom={8}
                    {...borderProps(6)}
                    backgroundColor={armed ? '#c0392b' : '#27344a'}
                    onClick={() =>
                      armed
                        ? useTeleopStore.getState().disarm()
                        : useTeleopStore.getState().arm()
                    }
                  >
                    <Text fontSize={13} color="#e8eef7">{armed ? 'ARMED — Stop' : 'Arm'}</Text>
                  </Container>
                )}
              </Container>
            </>
          )}
        </Container>
      </Root>
    </group>
  )
}
