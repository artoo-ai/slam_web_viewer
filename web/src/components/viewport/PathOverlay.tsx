import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { pathFeed } from '../../stores/pathFeed'
import { useLayersStore } from '../../stores/layersStore'

/** Nav2 global plan as a bright polyline just above the costmap layers. */

const CAPACITY = 4096

export function PathOverlay() {
  const visible = useLayersStore((s) => s.path)
  const lastVersion = useRef(-1)

  const { line, positionAttr, geometry } = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const positionAttr = new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3)
    positionAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttr)
    geometry.setDrawRange(0, 0)
    const material = new THREE.LineBasicMaterial({ color: 0xf59e0b })
    const line = new THREE.Line(geometry, material)
    line.frustumCulled = false
    return { line, positionAttr, geometry }
  }, [])

  useFrame(() => {
    if (pathFeed.version === lastVersion.current) return
    lastVersion.current = pathFeed.version
    const poses = pathFeed.poses
    const n = Math.min(pathFeed.count, CAPACITY)
    const pos = positionAttr.array as Float32Array
    for (let i = 0; i < n; i++) {
      pos[i * 3] = poses[i * 3]
      pos[i * 3 + 1] = poses[i * 3 + 1]
      pos[i * 3 + 2] = 0.05
    }
    positionAttr.needsUpdate = true
    geometry.setDrawRange(0, n)
  })

  line.visible = visible
  return <primitive object={line} />
}
