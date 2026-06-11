import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { poseFeed } from '../../stores/poseFeed'

/** Robot path polyline fed from the poseFeed ring buffer. Preallocated position
 *  attribute + setDrawRange; polled via poseFeed.version in useFrame. */

const CAPACITY = 20_000

export function TrajectoryOverlay() {
  const lastVersion = useRef(-1)

  const { line, positionAttr, geometry } = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const positionAttr = new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3)
    positionAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttr)
    geometry.setDrawRange(0, 0)
    const material = new THREE.LineBasicMaterial({ color: 0x38bdf8 })
    const line = new THREE.Line(geometry, material)
    line.frustumCulled = false
    return { line, positionAttr, geometry }
  }, [])

  useFrame(() => {
    if (poseFeed.version === lastVersion.current) return
    lastVersion.current = poseFeed.version
    const n = poseFeed.trajectoryCount
    ;(positionAttr.array as Float32Array).set(poseFeed.trajectory.subarray(0, n * 3))
    positionAttr.needsUpdate = true
    geometry.setDrawRange(0, n)
  })

  return <primitive object={line} />
}
