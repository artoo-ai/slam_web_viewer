import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { poseFeed } from '../../stores/poseFeed'

/** Current robot pose: a cone pointing along +x (REP-103 forward) plus a base
 *  disc. Position/quaternion set imperatively in useFrame. */
export function RobotPoseGlyph() {
  const group = useRef<THREE.Group>(null)

  useFrame(() => {
    const pose = poseFeed.latest
    if (!pose || !group.current) return
    group.current.position.set(pose.p[0], pose.p[1], pose.p[2])
    group.current.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3])
  })

  return (
    <group ref={group}>
      {/* cone's default axis is +y; rotate -90 deg about z so it points +x */}
      <mesh rotation={[0, 0, -Math.PI / 2]} position={[0.08, 0, 0]}>
        <coneGeometry args={[0.08, 0.24, 16]} />
        <meshBasicMaterial color="#fbbf24" />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.06, 12, 12]} />
        <meshBasicMaterial color="#f59e0b" />
      </mesh>
    </group>
  )
}
