import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { gridFeed, type GridLayer } from '../../stores/gridFeed'
import { useLayersStore } from '../../stores/layersStore'
import { GRID_UNKNOWN } from '../../lib/transport/protocol'

/** One occupancy/cost grid layer as an RGBA DataTexture on a floor-plane.
 *  Palettes: "map" reads as the SLAM map (free slate, occupied bright);
 *  "cost" mimics RViz costmap coloring (cost gradient blue->red, lethal
 *  magenta) so narrow-passage pinches look familiar. */

type Palette = 'map' | 'cost'

function colorizeMap(v: number, rgba: Uint8Array, o: number) {
  if (v < 50) {
    rgba[o] = 44
    rgba[o + 1] = 56
    rgba[o + 2] = 74
    rgba[o + 3] = 150
  } else {
    const b = 180 + v
    rgba[o] = b
    rgba[o + 1] = b
    rgba[o + 2] = b
    rgba[o + 3] = 235
  }
}

function colorizeCost(v: number, rgba: Uint8Array, o: number) {
  if (v === 0) {
    rgba[o + 3] = 0 // free: fully transparent so the map shows through
  } else if (v >= 100) {
    rgba[o] = 255 // lethal: magenta
    rgba[o + 1] = 0
    rgba[o + 2] = 255
    rgba[o + 3] = 220
  } else if (v >= 99) {
    rgba[o] = 235 // inscribed: red
    rgba[o + 1] = 50
    rgba[o + 2] = 50
    rgba[o + 3] = 200
  } else {
    // 1..98 gradient: deep blue -> cyan -> yellow -> red
    const k = v / 98
    rgba[o] = Math.round(255 * Math.min(1, Math.max(0, 2 * k - 0.5)))
    rgba[o + 1] = Math.round(255 * (k < 0.5 ? 2 * k : 2 - 2 * k))
    rgba[o + 2] = Math.round(255 * Math.max(0, 1 - 2 * k))
    rgba[o + 3] = 120 + Math.round(80 * k)
  }
}

function colorize(cells: Uint8Array, rgba: Uint8Array, palette: Palette) {
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i]
    const o = i * 4
    if (v === GRID_UNKNOWN) {
      rgba[o + 3] = 0
      continue
    }
    if (palette === 'map') colorizeMap(v, rgba, o)
    else colorizeCost(v, rgba, o)
  }
}

export function OccupancyGridLayer({
  layer,
  palette,
  z,
}: {
  layer: GridLayer
  palette: Palette
  z: number
}) {
  const visible = useLayersStore((s) => s[layer])
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
    const feed = gridFeed.layer(layer)
    if (feed.version === lastVersion.current) return
    const grid = feed.latest
    if (!grid || !mesh.current) return
    lastVersion.current = feed.version

    if (!state.current || state.current.w !== grid.width || state.current.h !== grid.height) {
      state.current?.texture.dispose()
      const rgba = new Uint8Array(grid.width * grid.height * 4)
      const texture = new THREE.DataTexture(rgba, grid.width, grid.height, THREE.RGBAFormat)
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      state.current = { texture, rgba, w: grid.width, h: grid.height }
      material.map = texture
      material.needsUpdate = true
    }

    colorize(grid.cells, state.current.rgba, palette)
    state.current.texture.needsUpdate = true
    mesh.current.scale.set(grid.width * grid.resolution, grid.height * grid.resolution, 1)

    // origin is the map-frame pose of cell (0,0)'s corner (ROS convention);
    // our plane is center-anchored, so offset by half the extent, rotated by theta
    const [ox, oy, theta] = grid.origin
    const hw = (grid.width * grid.resolution) / 2
    const hh = (grid.height * grid.resolution) / 2
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    mesh.current.position.set(ox + hw * cos - hh * sin, oy + hw * sin + hh * cos, z)
    mesh.current.rotation.set(0, 0, theta)
  })

  return (
    <mesh ref={mesh} material={material} visible={visible}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  )
}
