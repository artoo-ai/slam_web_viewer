import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { scanMainFeed } from '../../stores/scanMainFeed'
import { useLayersStore } from '../../stores/layersStore'

/** Main nav/SLAM band (/scan, the pointcloud_to_laserscan slice) as green
 *  dots. These are the points slam_toolbox matches against and the costmap's
 *  main obstacle_layer marks — the slice of the 3D cloud that actually drives
 *  mapping and obstacle avoidance. Rendered at the points' TRUE map-frame
 *  height (not flattened like scan_low) so they overlay the cloud exactly
 *  where that horizontal band sits — making "what does the 2D scan see"
 *  visible inside the full 3D point cloud. */

const CAPACITY = 8192

export function ScanMainLayer() {
  const visible = useLayersStore((s) => s.scan_main)
  const lastSeq = useRef(-1)

  const { points, positionAttr, geometry } = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const positionAttr = new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3)
    positionAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttr)
    geometry.setDrawRange(0, 0)
    const material = new THREE.PointsMaterial({
      color: 0x22c55e,
      size: 4,
      sizeAttenuation: false,
      depthWrite: false,
    })
    const points = new THREE.Points(geometry, material)
    points.frustumCulled = false
    points.renderOrder = 4
    return { points, positionAttr, geometry }
  }, [])

  useFrame(() => {
    if (scanMainFeed.seq === lastSeq.current) return
    lastSeq.current = scanMainFeed.seq
    const src = scanMainFeed.points
    if (!src) return
    const n = Math.min(scanMainFeed.count, CAPACITY)
    const pos = positionAttr.array as Float32Array
    for (let i = 0; i < n; i++) {
      pos[i * 3] = src[i * 4]
      pos[i * 3 + 1] = src[i * 4 + 1]
      pos[i * 3 + 2] = src[i * 4 + 2] // true height — overlay the band in the cloud
    }
    positionAttr.needsUpdate = true
    geometry.setDrawRange(0, n)
  })

  points.visible = visible
  return <primitive object={points} />
}
