import { useEffect, useRef, useState } from 'react'
import { Texture, SRGBColorSpace, type MeshBasicMaterial } from 'three'
import { useConnectionStore } from '../stores/connectionStore'
import { useMjpeg, cameraStreamUrl } from '../lib/mjpeg'

/** In-VR camera panel: the robot's live RGB MJPEG stream as a textured plane,
 *  placed to the LEFT of the HUD (rendered inside the HUD's follow group, so it
 *  rides with it). The HTTPS Quest page can't load the http://:8080 stream
 *  directly (mixed content) — cameraStreamUrl() targets the same-origin
 *  /camera proxy on a secure page. Reuses the shared fetch-based MJPEG reader.
 *
 *  Thin slice: the first advertised camera only. Mounted only inside <VrHud>
 *  while in session, so it never fetches on the flat desktop (that has its own
 *  CameraInset). */

const PANEL_WIDTH = 0.34 // metres
// The HUD panel is ~0.28 m wide (half ≈ 0.14) and centered on the group origin;
// put the camera's right edge just past its left edge so they don't overlap.
const RIGHT_EDGE = -0.17

export function VrCamera() {
  const cameras = useConnectionStore((s) => s.hello?.cameras)
  const name = (cameras?.length ? cameras : ['rgb'])[0]
  const { frameUrl } = useMjpeg(cameraStreamUrl(name))

  const matRef = useRef<MeshBasicMaterial>(null)
  const texRef = useRef<Texture | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [aspect, setAspect] = useState(16 / 9)

  // One reused Image + Texture; swap the Image src as frames arrive and flag the
  // texture for re-upload on each decode.
  useEffect(() => {
    const img = new Image()
    imgRef.current = img
    const tex = new Texture(img)
    tex.colorSpace = SRGBColorSpace
    texRef.current = tex
    img.onload = () => {
      if (img.naturalWidth) setAspect(img.naturalWidth / img.naturalHeight)
      tex.needsUpdate = true
    }
    if (matRef.current) {
      matRef.current.map = tex
      matRef.current.needsUpdate = true
    }
    return () => {
      img.onload = null
      tex.dispose()
    }
  }, [])

  useEffect(() => {
    if (frameUrl && imgRef.current) imgRef.current.src = frameUrl
  }, [frameUrl])

  const w = PANEL_WIDTH
  const h = PANEL_WIDTH / aspect
  return (
    <mesh position={[RIGHT_EDGE - w / 2, 0, 0]}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial ref={matRef} toneMapped={false} />
    </mesh>
  )
}
