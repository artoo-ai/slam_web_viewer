import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { scanLowFeed } from '../../stores/scanLowFeed'
import { useLayersStore } from '../../stores/layersStore'

/** Low-obstacle-band returns (/scan_low, 0.05–0.15 m slice) as red dots.
 *  These are the points the costmap's low_obstacle_layer marks — dog
 *  bowls, shoes, ankle-height clutter invisible to the main scan band.
 *  Rendered flattened to z = 0.06 so they hug the floor under the 3D
 *  cloud and read as "ground hazard" at a glance. */

const CAPACITY = 4096

export function ScanLowLayer() {
  const visible = useLayersStore((s) => s.scan_low)
  const lastSeq = useRef(-1)

  const { points, positionAttr, geometry } = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const positionAttr = new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3)
    positionAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttr)
    geometry.setDrawRange(0, 0)
    const material = new THREE.PointsMaterial({
      color: 0xef4444,
      size: 5,
      sizeAttenuation: false,
      depthWrite: false,
    })
    const points = new THREE.Points(geometry, material)
    points.frustumCulled = false
    points.renderOrder = 5
    return { points, positionAttr, geometry }
  }, [])

  useFrame(() => {
    if (scanLowFeed.seq === lastSeq.current) return
    lastSeq.current = scanLowFeed.seq
    const src = scanLowFeed.points
    if (!src) return
    const n = Math.min(scanLowFeed.count, CAPACITY)
    const pos = positionAttr.array as Float32Array
    for (let i = 0; i < n; i++) {
      pos[i * 3] = src[i * 4]
      pos[i * 3 + 1] = src[i * 4 + 1]
      pos[i * 3 + 2] = 0.06
    }
    positionAttr.needsUpdate = true
    geometry.setDrawRange(0, n)
  })

  points.visible = visible
  return <primitive object={points} />
}
