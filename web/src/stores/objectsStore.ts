import { create } from 'zustand'

/** Persistent semantic objects (Roborock-style object-on-map). Low rate —
 *  normal reactive store. Thumbnails become blob URLs once per object. */

export interface MapObject {
  id: string
  label: string
  confidence: number
  p: [number, number, number]
  count: number
  last_seen: number
  thumbUrl?: string
}

interface RawObject extends Omit<MapObject, 'thumbUrl'> {
  thumb?: Uint8Array
}

interface ObjectsState {
  objects: MapObject[]
  setObjects: (raw: RawObject[]) => void
}

const urlCache = new Map<string, string>()

export const useObjectsStore = create<ObjectsState>((set) => ({
  objects: [],
  setObjects: (raw) =>
    set({
      objects: raw.map((o) => {
        let thumbUrl = urlCache.get(o.id)
        if (!thumbUrl && o.thumb && o.thumb.byteLength > 0) {
          thumbUrl = URL.createObjectURL(new Blob([new Uint8Array(o.thumb)], { type: 'image/jpeg' }))
          urlCache.set(o.id, thumbUrl)
        }
        const { thumb: _thumb, ...rest } = o
        return { ...rest, thumbUrl }
      }),
    }),
}))
