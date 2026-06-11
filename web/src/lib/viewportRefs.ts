/** Imperative handles out of the R3F Canvas for toolbar features
 *  (screenshot, bookmarks, follow camera). Set by ViewportBridge. */

import type * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'

interface ViewportRefs {
  camera: THREE.PerspectiveCamera | null
  controls: OrbitControlsImpl | null
  canvas: HTMLCanvasElement | null
}

export const viewportRefs: ViewportRefs = {
  camera: null,
  controls: null,
  canvas: null,
}

/** rolling render-FPS estimate, updated each frame by ViewportBridge */
let frames = 0
let fps = 0
let windowStart = 0

export const fpsMeter = {
  tick(nowMs: number) {
    frames++
    if (nowMs - windowStart >= 1000) {
      fps = Math.round((frames * 1000) / (nowMs - windowStart))
      frames = 0
      windowStart = nowMs
    }
  },
  get fps() {
    return fps
  },
}

export function takeScreenshot() {
  const canvas = viewportRefs.canvas
  if (!canvas) return
  canvas.toBlob((blob) => {
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    a.download = `robot-gui-${stamp}.png`
    a.click()
    URL.revokeObjectURL(a.href)
  }, 'image/png')
}
