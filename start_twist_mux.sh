#!/usr/bin/env bash
# Launch twist_mux so manual teleop (/cmd_vel_teleop, priority 100) and Nav2
# (/cmd_vel_nav, priority 10) share the rover's single /cmd_vel input by
# priority instead of fighting. Releasing the joystick lets the teleop input
# time out (0.5 s) and hands /cmd_vel back to Nav2 automatically.
#
# Standalone, or called by ./start_bridge.sh --with-mux. Sources ROS2 Humble
# itself if it isn't already on PATH (skips re-sourcing when start_bridge.sh
# already did it for this process tree).
#
# Usage:
#   ./start_twist_mux.sh                              # output -> /cmd_vel
#   ./start_twist_mux.sh -r cmd_vel_out:=/cmd_vel_x   # extra ros2 args pass through
#
# Requires twist_mux (./install_jetson.sh installs it) and Nav2's controller /
# velocity_smoother output repointed to /cmd_vel_nav in slam_bringup.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROS_SETUP="/opt/ros/humble/setup.bash"
CONFIG="$SCRIPT_DIR/config/twist_mux.yaml"

# source ROS only if a parent (start_bridge.sh) hasn't already — ros2 on PATH
# means the environment is inherited and re-sourcing would be redundant
if ! command -v ros2 &>/dev/null; then
    if [[ ! -f "$ROS_SETUP" ]]; then
        echo "start_twist_mux: ERROR — ROS2 Humble not found ($ROS_SETUP)." >&2
        exit 1
    fi
    # ROS2 setup scripts reference unset variables — drop nounset while sourcing
    set +u
    # shellcheck disable=SC1090
    source "$ROS_SETUP"
    if [[ -f "$HOME/slam_ws/install/setup.bash" ]]; then
        # shellcheck disable=SC1091
        source "$HOME/slam_ws/install/setup.bash"
    fi
    set -u
fi

if ! ros2 pkg prefix twist_mux &>/dev/null; then
    echo "start_twist_mux: ERROR — twist_mux not installed. Run ./install_jetson.sh" >&2
    echo "                 (or: sudo apt install ros-\${ROS_DISTRO}-twist-mux)." >&2
    exit 1
fi
if [[ ! -f "$CONFIG" ]]; then
    echo "start_twist_mux: ERROR — config not found: $CONFIG" >&2
    exit 1
fi

echo "start_twist_mux: cmd_vel_teleop (100) + cmd_vel_nav (10) -> /cmd_vel"
# default output remap is /cmd_vel; any extra args ("$@") override or extend it
exec ros2 run twist_mux twist_mux --ros-args \
    --params-file "$CONFIG" -r cmd_vel_out:=/cmd_vel "$@"
