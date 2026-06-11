#!/usr/bin/env bash
# Start the viewer bridge — standalone: creates the venv and installs the
# bridge package on first run if needed.
#
# Usage:
#   ./start_bridge.sh                 # auto: ROS2 present -> live 3d, else mock
#   ./start_bridge.sh mock            # mock data generator (no ROS2 needed)
#   ./start_bridge.sh 2d              # live: slam_toolbox stack (/odom + /map)
#   ./start_bridge.sh 3d              # live: FAST-LIO2/RTABMap stack
#   ./start_bridge.sh 2d --port 9091  # extra args pass through to the bridge
#
# Live modes source /opt/ros/humble (+ ~/slam_ws/install if present) and use a
# --system-site-packages venv (bridge/.venv-ros) so rclpy is importable.
# Mock mode uses uv if installed, otherwise a plain venv (bridge/.venv-mock).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$SCRIPT_DIR/bridge"
ROS_SETUP="/opt/ros/humble/setup.bash"

MODE="${1:-auto}"
[[ $# -gt 0 ]] && shift

if [[ "$MODE" == "auto" ]]; then
    if [[ -f "$ROS_SETUP" ]]; then MODE="3d"; else MODE="mock"; fi
    echo "start_bridge: auto-selected mode '$MODE'"
fi

ensure_venv() {
    # ensure_venv <venv_path> <extra venv flags...>
    local venv="$1"; shift
    if [[ ! -x "$venv/bin/python" ]]; then
        echo "start_bridge: creating venv at $venv"
        python3 -m venv "$@" "$venv"
    fi
    if ! "$venv/bin/python" -c "import robot_bridge" &>/dev/null; then
        echo "start_bridge: installing bridge package into $venv"
        "$venv/bin/pip" install --quiet --upgrade pip
        "$venv/bin/pip" install --quiet -e "$BRIDGE_DIR"
    fi
}

case "$MODE" in
    mock)
        if command -v uv &>/dev/null; then
            cd "$BRIDGE_DIR"
            exec uv run python -m robot_bridge.mock "$@"
        else
            ensure_venv "$BRIDGE_DIR/.venv-mock"
            exec "$BRIDGE_DIR/.venv-mock/bin/python" -m robot_bridge.mock "$@"
        fi
        ;;
    2d|3d)
        if [[ ! -f "$ROS_SETUP" ]]; then
            echo "start_bridge: ERROR — mode '$MODE' needs ROS2 Humble ($ROS_SETUP not found)." >&2
            echo "             Use './start_bridge.sh mock' on machines without ROS2." >&2
            exit 1
        fi
        # shellcheck disable=SC1090
        source "$ROS_SETUP"
        # workspace overlay (custom messages not required, but harmless and
        # keeps DDS/domain settings consistent with the slam_bringup stack)
        if [[ -f "$HOME/slam_ws/install/setup.bash" ]]; then
            # shellcheck disable=SC1091
            source "$HOME/slam_ws/install/setup.bash"
        fi
        ensure_venv "$BRIDGE_DIR/.venv-ros" --system-site-packages
        if ! "$BRIDGE_DIR/.venv-ros/bin/python" -c "import rclpy" &>/dev/null; then
            echo "start_bridge: ERROR — venv cannot import rclpy even with ROS sourced." >&2
            echo "             Delete $BRIDGE_DIR/.venv-ros and re-run (it may have been" >&2
            echo "             created without --system-site-packages)." >&2
            exit 1
        fi
        exec "$BRIDGE_DIR/.venv-ros/bin/python" -m robot_bridge.ros2 --stack "$MODE" "$@"
        ;;
    *)
        echo "Usage: $0 [mock|2d|3d] [bridge args...]" >&2
        exit 1
        ;;
esac
