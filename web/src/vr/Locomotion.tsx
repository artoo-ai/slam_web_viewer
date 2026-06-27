import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector3, type Group } from 'three'
import { XROrigin, TeleportTarget, useXRInputSourceState, useXR } from '@react-three/xr'
import { useVrStore, clampWorldScale } from '../stores/vrModeStore'

// Module-level scratch vectors: avoid allocating in useFrame to reduce GC churn.
const _posA = new Vector3()
const _posB = new Vector3()

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

  useFrame(() => {
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

  return (
    <>
      {/* XROrigin: anchors the player to world space; room-scale movement is automatic.
          No position prop — defaults to (0,0,0); teleport mutates via ref outside render. */}
      <XROrigin ref={origin} />

      {/* TeleportTarget: wraps a large invisible floor plane at y=0.
          Only rendered during an active XR session — on desktop the invisible mesh would
          intercept R3F pointer raycasts (e.g. GoalControls double-click for Nav2 goals).
          onTeleport fires when the user pulls the trigger while pointing at it.
          The second arg (ThreeEvent<MouseEvent>) is intentionally omitted — TypeScript
          allows fewer parameters than declared. */}
      {inXR && (
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
      )}
    </>
  )
}
