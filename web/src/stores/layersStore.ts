import { create } from 'zustand'

/** Visibility toggles for viewport layers. Costmaps default off — they're
 *  debug overlays you turn on when chasing planner problems. */

export interface LayerVisibility {
  scan: boolean
  map_points: boolean
  trajectory: boolean
  map: boolean
  costmap_global: boolean
  costmap_local: boolean
  path: boolean
  camera: boolean
}

interface LayersState extends LayerVisibility {
  toggle: (layer: keyof LayerVisibility) => void
}

export const useLayersStore = create<LayersState>((set) => ({
  scan: true,
  map_points: true,
  trajectory: true,
  map: true,
  costmap_global: false,
  costmap_local: false,
  path: true,
  camera: true,
  toggle: (layer) => set((s) => ({ [layer]: !s[layer] }) as Partial<LayerVisibility>),
}))
