import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { viewportRefs, fpsMeter } from '../../lib/viewportRefs'
import { useViewerParams } from '../../stores/viewerParamsStore'
import { poseFeed } from '../../stores/poseFeed'

/** Exposes camera/controls/canvas to the UI layer (screenshot, bookmarks) and
 *  drives the Follow Pose camera modes. Renders nothing. */

const chaseOffset = new THREE.Vector3()
const desired = new THREE.Vector3()
const targetV = new THREE.Vector3()

export function ViewportBridge() {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)

  useEffect(() => {
    viewportRefs.camera = camera as THREE.PerspectiveCamera
    viewportRefs.controls = controls
    viewportRefs.canvas = gl.domElement
  }, [camera, controls, gl])

  // DEV diagnostic: run __vrDiag() in the browser console to dump renderer state.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as Record<string, unknown>).__vrDiag = () => {
      const cc = new THREE.Color()
      gl.getClearColor(cc)
      const rt = gl.getRenderTarget()
      return {
        fps: fpsMeter.fps,
        xrEnabled: gl.xr.enabled,
        xrPresenting: gl.xr.isPresenting,
        // render stats from the LAST frame — calls/points 0 means nothing drew
        lastFrame: { calls: gl.info.render.calls, points: gl.info.render.points, triangles: gl.info.render.triangles },
        renderTarget: rt ? `${rt.width}x${rt.height} (NON-NULL!)` : 'null (canvas)',
        canvas: `${gl.domElement.width}x${gl.domElement.height}`,
        clearColor: cc.getHexString(),
        clearAlpha: gl.getClearAlpha(),
        autoClear: gl.autoClear,
        sceneChildren: scene.children.length,
        camera: { type: camera.type, pos: camera.position.toArray().map((n) => +n.toFixed(2)), near: camera.near, far: camera.far },
      }
    }
  }, [gl, scene, camera])

  useFrame(() => {
    fpsMeter.tick(performance.now())
    const follow = useViewerParams.getState().follow
    if (controls) controls.enabled = follow === 'free'
    const pose = poseFeed.latest
    if (follow === 'free' || !pose || !controls) return

    targetV.set(pose.p[0], pose.p[1], pose.p[2])
    if (follow === 'chase') {
      const yaw = 2 * Math.atan2(pose.q[2], pose.q[3])
      chaseOffset.set(-Math.cos(yaw) * 4.0, -Math.sin(yaw) * 4.0, 2.2)
      desired.copy(targetV).add(chaseOffset)
    } else {
      desired.set(pose.p[0], pose.p[1] - 0.01, 18) // top-down (tiny y offset keeps up-vector stable)
    }
    camera.position.lerp(desired, 0.08)
    controls.target.lerp(targetV, 0.15)
    controls.update()
  })

  return null
}
