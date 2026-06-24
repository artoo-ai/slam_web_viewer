#!/usr/bin/env bash
# Install dependencies for the live bridge on the Jetson (ROS2 Humble).
# Creates bridge/.venv-ros with --system-site-packages so rclpy (from the
# sourced ROS2 environment) stays importable. Idempotent — safe to re-run.
#
# Assumes ROS2 Humble is already installed (it is, if the slam_bringup stack
# runs on this machine). This script does NOT install ROS2.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROS_SETUP="/opt/ros/humble/setup.bash"
VENV="$SCRIPT_DIR/bridge/.venv-ros"

echo "== robot_gui install (jetson) =="

if [[ ! -f "$ROS_SETUP" ]]; then
    echo "ERROR: $ROS_SETUP not found — this script is for a machine with ROS2 Humble." >&2
    echo "       On a dev machine without ROS2, run ./install_mac.sh instead." >&2
    exit 1
fi
# ROS2 setup scripts reference unset variables — drop nounset while sourcing
set +u
# shellcheck disable=SC1090
source "$ROS_SETUP"
set -u

if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found." >&2
    exit 1
fi

# python3-venv is not installed by default on Ubuntu — venv creation needs it
if ! python3 -m ensurepip --version &>/dev/null; then
    echo "-- python3-venv missing; installing via apt (sudo may prompt for password)"
    sudo apt-get install -y python3-venv
fi

# twist_mux: priority muxer so manual teleop (/cmd_vel_teleop) and Nav2
# (/cmd_vel_nav) can share the rover's single /cmd_vel input instead of
# fighting over it. OPTIONAL — the bridge drives /cmd_vel directly without it
# (fine for manual-only) — so a failed install only warns, never aborts.
TWIST_MUX_PKG="ros-${ROS_DISTRO:-humble}-twist-mux"
if ros2 pkg prefix twist_mux &>/dev/null; then
    echo "-- twist_mux already installed"
else
    echo "-- installing $TWIST_MUX_PKG via apt (sudo may prompt for password)"
    if sudo apt-get install -y "$TWIST_MUX_PKG"; then
        echo "   twist_mux OK"
    else
        echo "WARNING: could not install $TWIST_MUX_PKG. Teleop still works on" >&2
        echo "         /cmd_vel directly; install it later to run manual drive" >&2
        echo "         alongside Nav2 (see config/twist_mux.yaml)." >&2
    fi
fi

# a venv without pip is a half-created leftover from a failed attempt
if [[ -e "$VENV" && ! -x "$VENV/bin/pip" ]]; then
    echo "-- removing broken venv: $VENV"
    rm -rf "$VENV"
fi

if [[ -x "$VENV/bin/python" ]]; then
    echo "-- venv exists: $VENV"
else
    echo "-- creating venv (--system-site-packages): $VENV"
    python3 -m venv --system-site-packages "$VENV"
fi

echo "-- installing bridge package"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -e "$SCRIPT_DIR/bridge"

echo "-- verifying imports"
"$VENV/bin/python" -c "import robot_bridge, websockets, msgpack, numpy; print('   bridge deps OK')"
if "$VENV/bin/python" -c "import rclpy" &>/dev/null; then
    echo "   rclpy OK"
else
    echo "WARNING: rclpy not importable. Make sure $ROS_SETUP was sourced and" >&2
    echo "         delete $VENV before re-running if it was created without ROS." >&2
    exit 1
fi

echo
echo "Done. Next steps (after the SLAM stack is up):"
echo "  ./start_bridge.sh 2d            # slam_toolbox stack (start_explore_2d.sh)"
echo "  ./start_bridge.sh 3d            # FAST-LIO2/RTABMap stack"
echo "Then open the viewer on your dev machine:"
echo "  http://localhost:5173/?ws=ws://<this-jetson>:9090"
