import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { depthFeed } from '../../stores/depthFeed'
import { useLayersStore } from '../../stores/layersStore'

/** Depth-camera RGB point cloud (latest frame). True-color via vertexColors —
 *  this is the camera's view in 3D, complementing the intensity LiDAR cloud. */

const MAX_POINTS = 131_072

export function DepthPointsLayer() {
  const visible = useLayersStore((s) => s.depth_points)
  const lastSeq = useRef(-1)

  const { geometry, material, positionAttr, colorAttr } = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const positionAttr = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 3), 3)
    const colorAttr = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 3), 3)
    positionAttr.setUsage(THREE.DynamicDrawUsage)
    colorAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttr)
    geometry.setAttribute('color', colorAttr)
    geometry.setDrawRange(0, 0)
    const material = new THREE.PointsMaterial({
      size: 0.025,
      vertexColors: true,
      sizeAttenuation: true,
    })
    return { geometry, material, positionAttr, colorAttr }
  }, [])

  useFrame(() => {
    if (depthFeed.seq === lastSeq.current || !depthFeed.points) return
    lastSeq.current = depthFeed.seq
    const src = depthFeed.points
    const n = Math.min(depthFeed.count, MAX_POINTS)
    const pos = positionAttr.array as Float32Array
    const col = colorAttr.array as Float32Array
    for (let i = 0; i < n; i++) {
      const o = i * 6
      const d = i * 3
      pos[d] = src[o]
      pos[d + 1] = src[o + 1]
      pos[d + 2] = src[o + 2]
      col[d] = src[o + 3]
      col[d + 1] = src[o + 4]
      col[d + 2] = src[o + 5]
    }
    positionAttr.needsUpdate = true
    colorAttr.needsUpdate = true
    geometry.setDrawRange(0, n)
  })

  return <points geometry={geometry} material={material} frustumCulled={false} visible={visible} />
}
