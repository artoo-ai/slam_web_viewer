import * as THREE from 'three'
import { useViewerParams } from '../../stores/viewerParamsStore'

/** Shared point-cloud shader (live scan + accumulated map): turbo-ish ramp,
 *  intensity/height color modes, gamma. */

export const POINT_VERT = /* glsl */ `
  attribute float intensity;
  varying float vIntensity;
  uniform float uPointSize;
  uniform float uColorMode;  // 0 = intensity, 1 = height
  uniform float uZMin;
  uniform float uZMax;
  void main() {
    vIntensity = uColorMode < 0.5
      ? intensity
      : clamp((position.z - uZMin) / (uZMax - uZMin), 0.0, 1.0);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(uPointSize * (10.0 / -mvPosition.z), 1.0, 12.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`

export const POINT_FRAG = /* glsl */ `
  varying float vIntensity;
  uniform float uGamma;
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
    vec3 color = pow(ramp(vIntensity), vec3(1.0 / uGamma));
    gl_FragColor = vec4(color, 1.0);
  }
`

export function makePointMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    uniforms: {
      uPointSize: { value: 3.0 },
      uColorMode: { value: 0.0 },
      uZMin: { value: 0.0 },
      uZMax: { value: 2.5 },
      uGamma: { value: 1.0 },
    },
  })
}

/** Call once per frame to sync the material with the viewer params store. */
export function syncPointMaterial(material: THREE.ShaderMaterial, pointScale = 1.0) {
  const p = useViewerParams.getState()
  material.uniforms.uPointSize.value = p.pointSize * pointScale
  material.uniforms.uColorMode.value = p.colorMode === 'height' ? 1.0 : 0.0
  material.uniforms.uZMin.value = p.heightMin
  material.uniforms.uZMax.value = p.heightMax
  material.uniforms.uGamma.value = p.gamma
}
