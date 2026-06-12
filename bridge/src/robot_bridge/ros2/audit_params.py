"""The audited-parameter manifest — the load-bearing params whose stale values
have burned real debugging sessions (docs/diagnostics.md §1). One place only;
the viewer's expected-value manifest lives in web/src/config/expectedParams.ts.
"""

AUDITED_PARAMS: dict[str, list[str]] = {
    "controller_server": [
        "FollowPath.max_vel_theta",
        "FollowPath.min_theta_velocity_threshold",
    ],
    "behavior_server": [
        "max_rotational_vel",
        "min_rotational_vel",
    ],
    "velocity_smoother": [
        "max_velocity",
    ],
    "local_costmap/local_costmap": [
        "robot_radius",
        "inflation_layer.inflation_radius",
    ],
    "global_costmap/global_costmap": [
        "robot_radius",
        "inflation_layer.inflation_radius",
    ],
    "livox_to_scan": [
        "min_height",
        "max_height",
    ],
    "slam_toolbox": [
        "mode",
        "map_file_name",
    ],
}
