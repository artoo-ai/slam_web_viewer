import { create } from 'zustand'
import { viewportRefs } from '../lib/viewportRefs'

/** Named camera viewpoints, persisted to localStorage (SJY bookmark row). */

export interface Bookmark {
  name: string
  position: [number, number, number]
  target: [number, number, number]
}

const KEY = 'robot-gui-bookmarks'

function load(): Bookmark[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Bookmark[]
  } catch {
    return []
  }
}

interface BookmarksState {
  bookmarks: Bookmark[]
  save: (name: string) => void
  remove: (name: string) => void
  apply: (name: string) => void
}

export const useBookmarks = create<BookmarksState>((set, get) => ({
  bookmarks: load(),
  save: (name) => {
    const { camera, controls } = viewportRefs
    if (!camera || !controls || !name.trim()) return
    const bookmark: Bookmark = {
      name: name.trim(),
      position: camera.position.toArray() as [number, number, number],
      target: controls.target.toArray() as [number, number, number],
    }
    const bookmarks = [...get().bookmarks.filter((b) => b.name !== bookmark.name), bookmark]
    localStorage.setItem(KEY, JSON.stringify(bookmarks))
    set({ bookmarks })
  },
  remove: (name) => {
    const bookmarks = get().bookmarks.filter((b) => b.name !== name)
    localStorage.setItem(KEY, JSON.stringify(bookmarks))
    set({ bookmarks })
  },
  apply: (name) => {
    const bookmark = get().bookmarks.find((b) => b.name === name)
    const { camera, controls } = viewportRefs
    if (!bookmark || !camera || !controls) return
    camera.position.set(...bookmark.position)
    controls.target.set(...bookmark.target)
    controls.update()
  },
}))
