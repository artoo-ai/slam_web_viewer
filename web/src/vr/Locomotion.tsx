import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Euler, Quaternion, Vector3, type Group } from 'three'
import {
  XROrigin,
  TeleportTarget,
  useXRInputSourceState,
  useXR,
  useXRControllerLocomotion,
} from '@react-three/xr'
import { useVrStore, clampWorldScale } from '../stores/vrModeStore'
import { useTeleopStore } from '../stores/teleopStore'
import { poseFeed } from '../stores/poseFeed'
import { Z_UP_TO_Y_UP } from './coords'

const DRIVE_DEADZONE = 0.12 // ignore small thumbstick noise when driving the robot

// Module-level scratch vectors: avoid allocating in useFrame to reduce GC churn.
const _posA = new Vector3()
const _posB = new Vector3()
// Robot-POV scratch: map (z-up) → rendered world (the same transform SceneRoot
// applies — scale by worldScale, then rotate Z-up→Y-up).
const _zUpEuler = new Euler(...Z_UP_TO_Y_UP)
const _povPos = new Vector3()
const _povQuat = new Quaternion()
const _povFwd = new Vector3()

/**
 * Locomotion rig (mounted inside <XR>, active in both VR and AR sessions):
 *
 *  - room-scale walking:  free — the headset tracks movement within XROrigin automatically.
 *  - teleport:            point at the invisible floor plane and pull the primary trigger;
 *                         TeleportTarget calls onTeleport, which repositions XROrigin.
 *  - grab-to-scale:       hold both grip buttons simultaneously and move hands apart/together
 *                         to scale the world cloud via vrModeStore.setWorldScale.
 *
 * ── v6 API reconciliation (deviations from the task brief) ──────────────────────
 *
 * TeleportTarget.onTeleport signature:
 *   v6:   (point: Vector3, event: ThreeEvent<MouseEvent>) => void   (two args)
 *   brief: (p) => void                                               (one arg)
 *   Fix:  callback accepts one arg; TypeScript allows omitting trailing params.
 *
 * XROrigin position prop:
 *   brief: <XROrigin ref={origin} position={position.current} />
 *   actual: The `position.current` read during render triggers the react-hooks/refs lint rule.
 *   Fix:  Omit the position prop (XROrigin defaults to origin 0,0,0); on teleport, mutate
 *         origin.current.position directly via the ref — which is safe outside render.
 *
 * Squeeze detection:
 *   brief uses: session.inputSources → gamepad.buttons[1].pressed
 *   v6 uses:    useXRInputSourceState('controller', hand) → gamepad['xr-standard-squeeze']?.state
 *   Reason: @react-three/xr v6 maintains a typed XRControllerGamepadState (keyed by component ID,
 *           not numeric button index).  The XRControllerGamepadComponentState.state field carries
 *           'default' | 'touched' | 'pressed', matching the WebXR gamepad mapping spec.
 *
 * Controller world position:
 *   brief uses: frame.getPose(gripSpace, ref) (WebXR XRFrame API)
 *   v6 uses:    XRControllerState.object.getWorldPosition(vec) (Three.js Object3D)
 *   Reason: state.gl.xr.getFrame() is not a public method on WebXRManager in Three r184;
 *           the XR store's XRControllerState already exposes a synced Three.js object whose
 *           world matrix is updated each frame before useFrame runs.
 *
 * XR state access in useFrame:
 *   brief uses: state.gl.xr.getSession() inside useFrame
 *   v6 uses:    useXRInputSourceState('controller', hand) at component level (React hook),
 *               read inside useFrame via closure — always current because XR state changes
 *               trigger re-renders, refreshing the closure.
 */
export function Locomotion() {
  const origin = useRef<Group>(null)
  const grab = useRef<{ startDist: number; startScale: number } | null>(null)

  // True while an XR session is active; false on desktop.
  const inXR = useXR((s) => s.session != null)

  // XRControllerState | undefined — typed by v6; undefined when controller not present.
  const leftCtrl = useXRInputSourceState('controller', 'left')
  const rightCtrl = useXRInputSourceState('controller', 'right')

  // What the left thumbstick does: 'move' flies you through the world, 'drive'
  // teleoperates the robot. While driving we disable world-locomotion so the
  // stick doesn't also move you.
  const joystickMode = useVrStore((s) => s.joystickMode)
  const viewMode = useVrStore((s) => s.viewMode)
  const armed = useTeleopStore((s) => s.armed)
  const driving = joystickMode === 'drive'
  // The XROrigin is owned by the POV rig (or fought by free-move) when either
  // driving the robot or riding it — disable world-locomotion in both cases.
  const lockOrigin = driving || viewMode === 'robot'

  // Thumbstick locomotion: left stick slides across the map (relative to head yaw),
  // right stick smoothly rotates the view. Moves the XROrigin; no-op on desktop
  // (no controllers). Disabled while driving/riding the robot. Options are read
  // live each frame by the hook, so passing false here turns it off on mode flip.
  useXRControllerLocomotion(
    origin,
    lockOrigin ? false : { speed: 2 },
    lockOrigin ? false : { type: 'smooth', speed: 1.5 },
    'left',
  )

  // Robot POV: lock the XROrigin to the robot's live pose so you ride along.
  // poseFeed is in the SLAM map frame (z-up); rendered geometry is SceneRoot's
  // transform of it, so we apply the same scale+rotation to land the origin where
  // the robot is drawn.
  // NOTE: default priority (NOT a positive render priority). A positive useFrame
  // priority puts R3F into manual-render mode — it stops auto-rendering the scene,
  // which blanked the whole viewport. Locomotion is already disabled in robot mode
  // (lockOrigin), so no ordering against the locomotion hook is needed.
  useFrame(() => {
    if (!inXR || viewMode !== 'robot') return
    const pose = poseFeed.latest
    const o = origin.current
    if (!pose || !o) return
    const s = useVrStore.getState().worldScale
    _povPos.set(pose.p[0], pose.p[1], pose.p[2]).multiplyScalar(s).applyEuler(_zUpEuler)
    o.position.copy(_povPos)
    // Robot forward is +X in the map frame (see RobotPoseGlyph); map it to a world
    // yaw so "ahead" in the headset matches where the robot is heading.
    _povQuat.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3])
    _povFwd.set(1, 0, 0).applyQuaternion(_povQuat).applyEuler(_zUpEuler)
    o.rotation.set(0, Math.atan2(-_povFwd.x, -_povFwd.z), 0)
  })

  // Robot teleop: while in 'drive' mode AND armed, stream the left thumbstick as a
  // body twist into teleopStore — the always-mounted TeleopPanel sends it as
  // cmd_vel (and halts the robot via the bridge deadman on disarm/release).
  useFrame(() => {
    if (!inXR || !driving || !armed) return
    const stick = leftCtrl?.gamepad['xr-standard-thumbstick']
    let nx = stick?.xAxis ?? 0
    let ny = stick?.yAxis ?? 0 // thumbstick y is +down
    if (Math.hypot(nx, ny) < DRIVE_DEADZONE) {
      nx = 0
      ny = 0
    }
    useTeleopStore.getState().setVector(nx, -ny) // up on the stick = forward
  })

  useFrame(() => {
    if (!inXR) return
    const leftSqueeze =
      leftCtrl?.gamepad['xr-standard-squeeze']?.state === 'pressed'
    const rightSqueeze =
      rightCtrl?.gamepad['xr-standard-squeeze']?.state === 'pressed'

    if (!leftSqueeze || !rightSqueeze) {
      grab.current = null
      return
    }

    // Both squeeze buttons held — read controller world positions.
    const lo = leftCtrl?.object
    const ro = rightCtrl?.object
    if (!lo || !ro) {
      grab.current = null
      return
    }

    lo.getWorldPosition(_posA)
    ro.getWorldPosition(_posB)
    const dist = _posA.distanceTo(_posB)

    if (!grab.current) {
      // First frame of the gesture: record baseline.
      if (dist < 0.005) return // < 5 mm apart: degenerate start, wait for a real spread
      grab.current = {
        startDist: dist,
        startScale: useVrStore.getState().worldScale,
      }
    } else {
      // Subsequent frames: scale proportionally to hand-distance ratio.
      const next = clampWorldScale(
        grab.current.startScale * (dist / grab.current.startDist),
      )
      useVrStore.getState().setWorldScale(next)
    }
  })

  // Everything here is rendered ONLY during an active session. XROrigin adds the
  // XR camera to its group (group.add(gl.xr.getCamera())); on the flat desktop
  // (no session) that disturbs the normal camera and blanks the viewport — so it
  // must not exist outside a session. On desktop OrbitControls owns the camera and
  // no origin is needed. The teleport floor is likewise session-only (its invisible
  // mesh would otherwise intercept desktop pointer raycasts).
  if (!inXR) return null

  return (
    <>
      {/* XROrigin: anchors the player to world space; room-scale movement is automatic.
          No position prop — defaults to (0,0,0); teleport mutates via ref outside render. */}
      <XROrigin ref={origin} />

      {/* TeleportTarget: a large invisible floor plane at y=0; onTeleport fires when
          the user pulls the trigger while pointing at it. (Second arg
          ThreeEvent<MouseEvent> intentionally omitted — fewer params is allowed.) */}
      <TeleportTarget
        onTeleport={(p) => {
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
