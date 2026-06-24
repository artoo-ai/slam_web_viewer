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
#   ./start_bridge.sh 2d --with-mux   # also launch twist_mux; teleop drives
#                                     #   /cmd_vel_teleop, mux owns /cmd_vel
#                                     #   (needs Nav2 output repointed to
#                                     #    /cmd_vel_nav — see config/twist_mux.yaml)
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
    # a venv without pip is a half-created leftover from a failed attempt
    if [[ -e "$venv" && ! -x "$venv/bin/pip" ]]; then
        echo "start_bridge: removing broken venv at $venv"
        rm -rf "$venv"
    fi
    if [[ ! -x "$venv/bin/python" ]]; then
        echo "start_bridge: creating venv at $venv"
        if ! python3 -m venv "$@" "$venv"; then
            rm -rf "$venv"
            echo "start_bridge: ERROR — venv creation failed (python3-venv not installed?)." >&2
            echo "             Run ./install_jetson.sh, or: sudo apt install python3-venv" >&2
            exit 1
        fi
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
        # ROS2 setup scripts reference unset variables — drop nounset while sourcing
        set +u
        # shellcheck disable=SC1090
        source "$ROS_SETUP"
        # workspace overlay (custom messages not required, but harmless and
        # keeps DDS/domain settings consistent with the slam_bringup stack)
        if [[ -f "$HOME/slam_ws/install/setup.bash" ]]; then
            # shellcheck disable=SC1091
            source "$HOME/slam_ws/install/setup.bash"
        fi
        set -u
        ensure_venv "$BRIDGE_DIR/.venv-ros" --system-site-packages
        if ! "$BRIDGE_DIR/.venv-ros/bin/python" -c "import rclpy" &>/dev/null; then
            echo "start_bridge: ERROR — venv cannot import rclpy even with ROS sourced." >&2
            echo "             Delete $BRIDGE_DIR/.venv-ros and re-run (it may have been" >&2
            echo "             created without --system-site-packages)." >&2
            exit 1
        fi
        # --with-mux: also launch twist_mux (via start_twist_mux.sh) and point
        # teleop at its /cmd_vel_teleop input. The flag is consumed here, not
        # passed through to the bridge.
        WITH_MUX=0
        BRIDGE_ARGS=()
        for arg in "$@"; do
            if [[ "$arg" == "--with-mux" ]]; then WITH_MUX=1
            else BRIDGE_ARGS+=("$arg"); fi
        done

        TELEOP_ARGS=()
        if [[ "$WITH_MUX" == 1 ]]; then
            echo "start_bridge: launching twist_mux via start_twist_mux.sh"
            "$SCRIPT_DIR/start_twist_mux.sh" &
            MUX_PID=$!
            trap 'echo "start_bridge: stopping twist_mux ($MUX_PID)"; kill "$MUX_PID" 2>/dev/null || true' EXIT INT TERM
            # feed the mux instead of /cmd_vel directly. A user-supplied
            # --teleop-topic later in the args still wins (argparse takes last).
            TELEOP_ARGS=(--teleop-topic /cmd_vel_teleop)
        fi

        BRIDGE=("$BRIDGE_DIR/.venv-ros/bin/python" -m robot_bridge.ros2 --stack "$MODE")
        if [[ "$WITH_MUX" == 1 ]]; then
            # NOT exec: keep this shell alive so the trap can reap twist_mux
            "${BRIDGE[@]}" "${TELEOP_ARGS[@]+"${TELEOP_ARGS[@]}"}" "${BRIDGE_ARGS[@]+"${BRIDGE_ARGS[@]}"}"
        else
            exec "${BRIDGE[@]}" "${BRIDGE_ARGS[@]+"${BRIDGE_ARGS[@]}"}"
        fi
        ;;
    *)
        echo "Usage: $0 [mock|2d|3d] [bridge args...]" >&2
        exit 1
        ;;
esac
