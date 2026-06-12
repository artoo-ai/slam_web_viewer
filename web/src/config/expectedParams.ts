/** Expected-value manifest for the deployed-config audit
 *  (docs/diagnostics.md §1). Keep in sync with the slam_bringup configs and
 *  the bridge's audit list (robot_bridge/ros2/audit_params.py).
 *  `expect: null` = informational row (per-run value, no pass/fail). */

export interface ExpectedParam {
  node: string
  param: string
  expect: number | string | boolean | number[] | null
  tip: string
}

/** Known node/param combos for the Remote Param dropdown that are NOT part of
 *  the audit (runtime toggles, per-run knobs). suggest = value to prefill. */
export interface KnownParam {
  node: string
  param: string
  suggest: string
  tip: string
}

export const EXTRA_KNOWN_PARAMS: KnownParam[] = [
  { node: 'd435_front/camera', param: 'pointcloud.enable', suggest: 'true',
    tip: 'Turn the RealSense xyzrgb point cloud on/off at runtime (feeds the Depth Camera layer). x86 builds use this name.' },
  { node: 'd435_front/camera', param: 'pointcloud__neon_.enable', suggest: 'true',
    tip: 'Same toggle, NEON-accelerated variant — the one the Jetson ARM build actually uses (set both to be safe).' },
  { node: 'd435_front/camera', param: 'rgb_camera.enable_auto_exposure', suggest: 'true',
    tip: 'Camera auto-exposure — turn off if the image pumps brightness while driving.' },
  { node: 'controller_server', param: 'FollowPath.max_vel_x', suggest: '0.3',
    tip: 'Forward speed cap — drop it while debugging to slow everything down.' },
  { node: 'velocity_smoother', param: 'feedback', suggest: 'OPEN_LOOP',
    tip: 'Velocity smoother feedback mode.' },
]

export const EXPECTED_PARAMS: ExpectedParam[] = [
  { node: 'controller_server', param: 'FollowPath.max_vel_theta', expect: 0.6,
    tip: 'Rotation speed cap — above 0.6 rad/s rf2o loses spins and the map smears (the 1.0+ rad/s runs destroyed maps).' },
  { node: 'controller_server', param: 'FollowPath.min_theta_velocity_threshold', expect: 0.05,
    tip: 'Below this the mecanum wheels slip in place without rotating the chassis.' },
  { node: 'behavior_server', param: 'max_rotational_vel', expect: 0.6,
    tip: 'Spin-recovery speed cap — must match the controller cap or recoveries smear the map.' },
  { node: 'behavior_server', param: 'min_rotational_vel', expect: 0.4, tip: 'Spin-recovery floor.' },
  { node: 'velocity_smoother', param: 'max_velocity', expect: [0.5, 0.3, 0.6],
    tip: 'Smoother output limits [vx, vy, wz] — the wz entry must respect the 0.6 cap too.' },
  { node: 'local_costmap/local_costmap', param: 'robot_radius', expect: 0.25,
    tip: 'Footprint radius: chassis 0.18 + fixture overhang margin. Too small = clipped door frames.' },
  { node: 'local_costmap/local_costmap', param: 'inflation_layer.inflation_radius', expect: 0.3,
    tip: 'Obstacle inflation. Larger seals narrow passages (the "robot won’t move" failure).' },
  { node: 'global_costmap/global_costmap', param: 'robot_radius', expect: 0.25,
    tip: 'Must match the local costmap radius.' },
  { node: 'global_costmap/global_costmap', param: 'inflation_layer.inflation_radius', expect: 0.3,
    tip: 'Must match the local costmap inflation.' },
  { node: 'livox_to_scan', param: 'min_height', expect: 0.15,
    tip: '2D scan slice floor. Too low + sensor tilt = floor returns become phantom obstacles.' },
  { node: 'livox_to_scan', param: 'max_height', expect: 0.45, tip: '2D scan slice ceiling.' },
  { node: 'slam_toolbox', param: 'mode', expect: null,
    tip: 'mapping vs localization — per-run choice; shown so you can confirm which one is actually live.' },
  { node: 'slam_toolbox', param: 'map_file_name', expect: null,
    tip: 'Loaded map for resume runs — empty means fresh map.' },
]
