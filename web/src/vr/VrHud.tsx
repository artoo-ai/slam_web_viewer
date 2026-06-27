import { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Root, Container, Text } from '@react-three/uikit'
import type { Group } from 'three'
import { useConnectionStore } from '../stores/connectionStore'
import { useLayersStore, type LayerVisibility } from '../stores/layersStore'
import { useVrStore } from '../stores/vrModeStore'
import { xrStore } from './xrStore'
import { mapFeed } from '../stores/mapFeed'
import { scanFeed } from '../stores/scanFeed'
import { fpsMeter } from '../lib/viewportRefs'

/** Floating VR HUD (session-only). Parented to a group we lock ~1.2m in front of
 *  the camera each frame so it follows the operator. Points/FPS are updated via
 *  setInterval at ~10 Hz (not per-frame) to keep VR framerate stable. */
const HUD_LAYERS: (keyof LayerVisibility)[] = [
  'scan', 'map_points', 'trajectory', 'map', 'costmap_global', 'costmap_local', 'path',
]

// Radius applied to all four corners of a container.
function borderProps(r: number) {
  return {
    borderTopLeftRadius: r,
    borderTopRightRadius: r,
    borderBottomLeftRadius: r,
    borderBottomRightRadius: r,
  } as const
}

export function VrHud() {
  const mode = useVrStore((s) => s.mode)
  const status = useConnectionStore((s) => s.status)
  const layers = useLayersStore()
  const toggle = useLayersStore((s) => s.toggle)
  const setMode = useVrStore((s) => s.setMode)

  // setInterval fallback for Points/FPS at ~10 Hz (imperative setText not available in uikit 1.0.74)
  const [scene, setScene] = useState({ pts: 0, fps: 0 })
  useEffect(() => {
    const t = setInterval(
      () => setScene({ pts: mapFeed.count + scanFeed.count, fps: fpsMeter.fps }),
      100,
    )
    return () => clearInterval(t)
  }, [])

  const hudRef = useRef<Group>(null)

  // Head-lock: copy camera position + orientation then step 1.2 m forward each frame.
  useFrame((state) => {
    if (hudRef.current) {
      const cam = state.camera
      hudRef.current.position.copy(cam.position)
      hudRef.current.quaternion.copy(cam.quaternion)
      hudRef.current.translateZ(-1.2)
    }
  })

  if (mode === 'none') return null

  return (
    <group ref={hudRef}>
      {/* pixelSize, anchorX, anchorY confirmed in @react-three/uikit 1.0.74 */}
      <Root pixelSize={0.0016} anchorX="center" anchorY="center">
        {/*
          API deviations from brief applied:
          - `gap` → `gapColumn` / `gapRow` (no gap shorthand)
          - `padding` → individual sides (paddingTop/Left/Right/Bottom)
          - `borderRadius` → four individual corner props via borderProps()
          - `backgroundOpacity` → dropped (no such prop; use `opacity` on the group if needed)
          - `paddingX`/`paddingY` → paddingLeft+paddingRight / paddingTop+paddingBottom
        */}
        <Container
          flexDirection="column"
          gapRow={8}
          paddingTop={14}
          paddingLeft={14}
          paddingRight={14}
          paddingBottom={14}
          {...borderProps(10)}
          backgroundColor="#141d2b"
          width={420}
        >
          <Text fontSize={20} color="#e8eef7">Robot GUI · VR</Text>
          <Text fontSize={14} color={status === 'open' ? '#5fd08a' : '#d0825f'}>
            {status === 'open' ? 'Connected' : status}
          </Text>
          <Text fontSize={14} color="#9fb2cc">
            {`Points ${scene.pts.toLocaleString()}  ·  ${scene.fps} FPS`}
          </Text>

          <Text fontSize={13} color="#7f93ad">Layers</Text>
          {/* flexWrap value "wrap" confirmed valid in uikit 1.0.74 */}
          <Container flexDirection="row" flexWrap="wrap" gapRow={6} gapColumn={6}>
            {HUD_LAYERS.map((key) => (
              <Container
                key={key}
                paddingLeft={10}
                paddingRight={10}
                paddingTop={6}
                paddingBottom={6}
                {...borderProps(6)}
                backgroundColor={layers[key] ? '#2f6df0' : '#27344a'}
                onClick={() => toggle(key)}
              >
                <Text fontSize={12} color="#e8eef7">{key}</Text>
              </Container>
            ))}
          </Container>

          <Container flexDirection="row" gapColumn={8}>
            <Container
              paddingLeft={12}
              paddingRight={12}
              paddingTop={8}
              paddingBottom={8}
              {...borderProps(6)}
              backgroundColor={mode === 'vr' ? '#2f6df0' : '#27344a'}
              onClick={() => { setMode('vr'); xrStore.enterVR().catch(() => {}) }}
            >
              <Text fontSize={13} color="#e8eef7">Void</Text>
            </Container>
            <Container
              paddingLeft={12}
              paddingRight={12}
              paddingTop={8}
              paddingBottom={8}
              {...borderProps(6)}
              backgroundColor={mode === 'ar' ? '#2f6df0' : '#27344a'}
              onClick={() => { setMode('ar'); xrStore.enterAR().catch(() => {}) }}
            >
              <Text fontSize={13} color="#e8eef7">Passthrough</Text>
            </Container>
          </Container>
        </Container>
      </Root>
    </group>
  )
}
