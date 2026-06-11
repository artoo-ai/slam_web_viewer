import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { mapFeed } from '../../stores/mapFeed'
import { useLayersStore } from '../../stores/layersStore'
import { makePointMaterial, syncPointMaterial } from './pointShader'

/** Accumulated map: append-only growth into a preallocated buffer, mirroring
 *  mapFeed. Slightly smaller points than the live scan so the fresh sweep
 *  reads on top of the map. */

const CAPACITY = 2_000_000

export function MapPointsLayer() {
  const visible = useLayersStore((s) => s.map_points)
  const synced = useRef(0) // points already copied into the GPU buffer

  const { geometry, material, positionAttr, intensityAttr } = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const positionAttr = new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3)
    const intensityAttr = new THREE.BufferAttribute(new Float32Array(CAPACITY), 1)
    positionAttr.setUsage(THREE.DynamicDrawUsage)
    intensityAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttr)
    geometry.setAttribute('intensity', intensityAttr)
    geometry.setDrawRange(0, 0)
    return { geometry, material: makePointMaterial(), positionAttr, intensityAttr }
  }, [])

  useFrame(() => {
    syncPointMaterial(material, 0.7)
    const total = mapFeed.count
    if (total < synced.current) synced.current = 0 // feed was cleared
    if (total === synced.current) return
    const src = mapFeed.buffer
    const pos = positionAttr.array as Float32Array
    const inten = intensityAttr.array as Float32Array
    for (let i = synced.current; i < total; i++) {
      const o = i * 4
      pos[i * 3] = src[o]
      pos[i * 3 + 1] = src[o + 1]
      pos[i * 3 + 2] = src[o + 2]
      inten[i] = src[o + 3]
    }
    synced.current = total
    positionAttr.needsUpdate = true
    intensityAttr.needsUpdate = true
    geometry.setDrawRange(0, total)
  })

  return <points geometry={geometry} material={material} frustumCulled={false} visible={visible} />
}
