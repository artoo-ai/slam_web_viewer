import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { gridFeed } from '../../stores/gridFeed'
import { GRID_UNKNOWN } from '../../lib/transport/protocol'

/** Occupancy grid rendered as an RGBA DataTexture on a plane just above the
 *  floor. unknown -> transparent, free -> faint slate, occupied -> bright.
 *  Updates at grid rate (~0.5 Hz); texture is rebuilt when dimensions change. */

// cell value -> RGBA
function colorize(cells: Uint8Array, rgba: Uint8Array) {
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i]
    const o = i * 4
    if (v === GRID_UNKNOWN) {
      rgba[o] = 0
      rgba[o + 1] = 0
      rgba[o + 2] = 0
      rgba[o + 3] = 0
    } else if (v < 50) {
      // free — faint slate so explored area reads against the dark bg
      rgba[o] = 44
      rgba[o + 1] = 56
      rgba[o + 2] = 74
      rgba[o + 3] = 150
    } else {
      // occupied — bright, scaled a touch by probability
      const b = 180 + v // 230..255
      rgba[o] = b
      rgba[o + 1] = b
      rgba[o + 2] = b
      rgba[o + 3] = 235
    }
  }
}

export function OccupancyGridLayer() {
  const lastVersion = useRef(-1)
  const mesh = useRef<THREE.Mesh>(null)
  const state = useRef<{ texture: THREE.DataTexture; rgba: Uint8Array; w: number; h: number } | null>(null)

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [],
  )

  useFrame(() => {
    if (gridFeed.version === lastVersion.current) return
    const grid = gridFeed.latest
    if (!grid || !mesh.current) return
    lastVersion.current = gridFeed.version

    if (!state.current || state.current.w !== grid.width || state.current.h !== grid.height) {
      state.current?.texture.dispose()
      const rgba = new Uint8Array(grid.width * grid.height * 4)
      const texture = new THREE.DataTexture(rgba, grid.width, grid.height, THREE.RGBAFormat)
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      state.current = { texture, rgba, w: grid.width, h: grid.height }
      material.map = texture
      material.needsUpdate = true
      // plane is 1x1 — scale to world size; anchored at center
      mesh.current.scale.set(grid.width * grid.resolution, grid.height * grid.resolution, 1)
    }

    colorize(grid.cells, state.current.rgba)
    state.current.texture.needsUpdate = true

    // origin is the map-frame pose of cell (0,0)'s corner (ROS convention);
    // our plane is center-anchored, so offset by half the extent, rotated by theta
    const [ox, oy, theta] = grid.origin
    const hw = (grid.width * grid.resolution) / 2
    const hh = (grid.height * grid.resolution) / 2
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    mesh.current.position.set(ox + hw * cos - hh * sin, oy + hw * sin + hh * cos, 0.01)
    mesh.current.rotation.set(0, 0, theta)
  })

  return (
    <mesh ref={mesh} material={material} visible={true}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  )
}
