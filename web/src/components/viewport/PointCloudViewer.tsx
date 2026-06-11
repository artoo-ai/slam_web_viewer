import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { scanFeed } from '../../stores/scanFeed'
import { useLayersStore } from '../../stores/layersStore'

/** Live LiDAR scan layer. Geometry is preallocated once at MAX_POINTS; each new
 *  scan de-interleaves xyzI into the position/intensity attributes, flags
 *  needsUpdate, and adjusts setDrawRange. Polled via scanFeed.seq in useFrame —
 *  no React state at scan rate. */

const MAX_POINTS = 262_144

const VERT = /* glsl */ `
  attribute float intensity;
  varying float vIntensity;
  uniform float uPointSize;
  void main() {
    vIntensity = intensity;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(uPointSize * (10.0 / -mvPosition.z), 1.0, 6.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`

// turbo-like colormap, cheap polynomial approximation
const FRAG = /* glsl */ `
  varying float vIntensity;
  vec3 ramp(float t) {
    t = clamp(t, 0.0, 1.0);
    return vec3(
      clamp(1.6 * t - 0.2, 0.0, 1.0),
      clamp(1.8 - abs(2.6 * t - 1.4), 0.0, 1.0),
      clamp(1.3 - 1.6 * t, 0.0, 1.0)
    );
  }
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
    gl_FragColor = vec4(ramp(vIntensity), 1.0);
  }
`

export function PointCloudViewer() {
  const visible = useLayersStore((s) => s.scan)
  const lastSeq = useRef(-1)

  const { geometry, material, positionAttr, intensityAttr } = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    const positionAttr = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 3), 3)
    const intensityAttr = new THREE.BufferAttribute(new Float32Array(MAX_POINTS), 1)
    positionAttr.setUsage(THREE.DynamicDrawUsage)
    intensityAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttr)
    geometry.setAttribute('intensity', intensityAttr)
    geometry.setDrawRange(0, 0)
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uPointSize: { value: 3.0 } },
    })
    return { geometry, material, positionAttr, intensityAttr }
  }, [])

  useFrame(() => {
    if (scanFeed.seq === lastSeq.current || !scanFeed.points) return
    lastSeq.current = scanFeed.seq
    const xyzi = scanFeed.points
    const n = Math.min(scanFeed.count, MAX_POINTS)
    const pos = positionAttr.array as Float32Array
    const inten = intensityAttr.array as Float32Array
    for (let i = 0; i < n; i++) {
      const src = i * 4
      const dst = i * 3
      pos[dst] = xyzi[src]
      pos[dst + 1] = xyzi[src + 1]
      pos[dst + 2] = xyzi[src + 2]
      inten[i] = xyzi[src + 3]
    }
    positionAttr.needsUpdate = true
    intensityAttr.needsUpdate = true
    geometry.setDrawRange(0, n)
  })

  return <points geometry={geometry} material={material} frustumCulled={false} visible={visible} />
}
