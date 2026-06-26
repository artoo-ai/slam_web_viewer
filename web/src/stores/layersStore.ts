import { create } from 'zustand'

/** Visibility toggles for viewport layers. Costmaps default off — they're
 *  debug overlays you turn on when chasing planner problems. */

export interface LayerVisibility {
  scan: boolean
  scan_low: boolean
  scan_main: boolean
  depth_points: boolean
  map_points: boolean
  trajectory: boolean
  map: boolean
  costmap_global: boolean
  costmap_local: boolean
  path: boolean
  camera: boolean
  /** the per-component SLAM diagnostics card (rf2o/slam_toolbox/nav2/rtabmap/fast-lio2) */
  diagnostics: boolean
  /** the manual-drive joystick panel (only shown if the server advertises teleop) */
  teleop: boolean
}

interface LayersState extends LayerVisibility {
  toggle: (layer: keyof LayerVisibility) => void
}

export const useLayersStore = create<LayersState>((set) => ({
  scan: true,
  scan_low: true,
  scan_main: true,
  depth_points: true,
  map_points: true,
  trajectory: true,
  map: true,
  costmap_global: false,
  costmap_local: false,
  path: true,
  camera: true,
  diagnostics: true,
  teleop: true,
  toggle: (layer) => set((s) => ({ [layer]: !s[layer] }) as Partial<LayerVisibility>),
}))
