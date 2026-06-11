import { useRef } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { useNavStore } from '../../stores/navStore'
import { poseFeed } from '../../stores/poseFeed'

/** Double-click anywhere on the floor to send a nav goal there. The goal's
 *  heading defaults to the direction of travel (robot -> goal). A pulsing ring
 *  marks the active goal until a terminal nav_status clears it. */

export function GoalClickPlane() {
  const sendGoal = useNavStore((s) => s.sendGoal)

  const onDoubleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    const { x, y } = e.point
    const robot = poseFeed.latest
    const theta = robot ? Math.atan2(y - robot.p[1], x - robot.p[0]) : 0
    sendGoal(x, y, theta)
  }

  return (
    <mesh position={[0, 0, 0]} onDoubleClick={onDoubleClick}>
      <planeGeometry args={[400, 400]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  )
}

export function GoalMarker() {
  const goal = useNavStore((s) => s.goal)
  const ring = useRef<THREE.Group>(null)

  useFrame(({ clock }) => {
    if (!ring.current) return
    const pulse = 1 + 0.15 * Math.sin(clock.elapsedTime * 4)
    ring.current.scale.set(pulse, pulse, 1)
  })

  if (!goal) return null
  return (
    <group position={[goal.x, goal.y, 0.03]}>
      <group ref={ring}>
        <mesh>
          <ringGeometry args={[0.18, 0.26, 32]} />
          <meshBasicMaterial color="#34d399" transparent opacity={0.9} side={THREE.DoubleSide} />
        </mesh>
      </group>
      {/* heading tick */}
      <mesh position={[0.35 * Math.cos(goal.theta), 0.35 * Math.sin(goal.theta), 0]}
            rotation={[0, 0, goal.theta - Math.PI / 2]}>
        <coneGeometry args={[0.06, 0.16, 12]} />
        <meshBasicMaterial color="#34d399" />
      </mesh>
    </group>
  )
}
