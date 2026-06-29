#!/usr/bin/env bash
# Bring up everything the robot_gui / VR viewer needs against the 2D SLAM stack
# in one command: 2D SLAM (slam_toolbox) + D435 camera + Yahboom base, then the
# viewer bridge. Each robot-stack piece is launched in the background (logged)
# and verified alive; only then is the bridge started in the foreground.
#
# Re-running restarts the whole stack cleanly — the underlying start_*.sh scripts
# kill their prior instances first. This is also how you recover after picking the
# robot up and setting it down somewhere else: a fresh SLAM run re-localizes from
# scratch (slam_toolbox otherwise keeps dead-reckoning from the old pose).
#
# Startup ORDER MATTERS: start_slam_2d.sh runs kill_sensors.sh, which tears down
# the D435 — so SLAM is started BEFORE the camera. Yahboom is independent.
#
# Usage:
#   ./start_viz_stack.sh                        # SLAM scripts in the default folder
#   ./start_viz_stack.sh /path/to/slam_bringup  # explicit folder
#   SLAM_DIR=/path/to/slam_bringup ./start_viz_stack.sh
#   ./start_viz_stack.sh --no-bridge            # robot stack only (start bridge yourself)
#   ./start_viz_stack.sh --stop                 # tear the whole stack down (incl. bridge)
#
# The folder holding slam_bringup's start_*.sh / kill_*.sh scripts is taken from
# (in order):  arg1  →  $SLAM_DIR  →  the default below.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SLAM_DIR="/home/rico/slam_ws/src/slam_bringup"
LOG_DIR="${VIZ_LOG_DIR:-/tmp/viz_stack}"

START_BRIDGE=1
STOP=0
SLAM_DIR_ARG=""
for arg in "$@"; do
  case "$arg" in
    --no-bridge) START_BRIDGE=0 ;;
    --stop)      STOP=1 ;;
    -h|--help)   sed -n '2,28p' "$0"; exit 0 ;;
    --*)         echo "unknown flag: $arg" >&2; exit 2 ;;
    *)           SLAM_DIR_ARG="$arg" ;;
  esac
done

SLAM_DIR="${SLAM_DIR_ARG:-${SLAM_DIR:-$DEFAULT_SLAM_DIR}}"

if [[ ! -d "$SLAM_DIR" ]]; then
  echo "ERROR: slam_bringup folder not found: $SLAM_DIR" >&2
  echo "       pass it as the first argument or set \$SLAM_DIR." >&2
  exit 1
fi

stop_stack() {
  echo "Stopping viewer stack…"
  echo "  bridge"; pkill -f 'robot_bridge.ros2' 2>/dev/null || true
  for k in kill_slam_2d.sh kill_d435.sh kill_yahboom.sh; do
    if [[ -x "$SLAM_DIR/$k" ]]; then
      echo "  $k"; "$SLAM_DIR/$k" 2>/dev/null || true
    fi
  done
  echo "Done."
}

if [[ "$STOP" == 1 ]]; then stop_stack; exit 0; fi

mkdir -p "$LOG_DIR"

# launch_bg <label> <script> [args...] — start a slam_bringup start_*.sh in the
# background (detached, logged) and record its PID for the liveness check.
declare -a LABELS PIDS
launch_bg() {
  local label="$1" script="$2"; shift 2
  local path="$SLAM_DIR/$script"
  if [[ ! -x "$path" ]]; then
    echo "ERROR: $script not found or not executable in $SLAM_DIR" >&2
    exit 1
  fi
  local log="$LOG_DIR/${label}.log"
  echo "==> starting ${label}   ($script)   log: $log"
  # setsid+nohup so the launch survives this script exiting / Ctrl-C of the bridge.
  setsid nohup bash "$path" "$@" >"$log" 2>&1 < /dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  LABELS+=("$label"); PIDS+=("$pid")
}

# Robot stack, dependency-safe order: SLAM first (it resets the sensors), then the
# camera (so it isn't torn down by SLAM's kill_sensors), then the base.
launch_bg slam_2d  start_slam_2d.sh
sleep 6   # let SLAM tear down + relaunch sensors/perception before the camera
launch_bg d435     start_d435.sh
sleep 3
launch_bg yahboom  start_yahboom.sh

echo
echo "Waiting for processes to settle…"
sleep 6

ok=1
echo
printf "  %-10s %-7s %s\n" "component" "pid" "status"
printf "  %-10s %-7s %s\n" "---------" "------" "------"
for i in "${!LABELS[@]}"; do
  label="${LABELS[$i]}"; pid="${PIDS[$i]}"
  if kill -0 "$pid" 2>/dev/null; then
    printf "  %-10s %-7s UP\n" "$label" "$pid"
  else
    printf "  %-10s %-7s FAILED — see %s/%s.log\n" "$label" "$pid" "$LOG_DIR" "$label"
    ok=0
  fi
done
echo

if [[ "$ok" != 1 ]]; then
  echo "One or more components failed to start. Bridge NOT started." >&2
  echo "Check the logs in $LOG_DIR, fix the cause, and re-run." >&2
  exit 1
fi

if [[ "$START_BRIDGE" != 1 ]]; then
  echo "Robot stack is up. (--no-bridge) Start the viewer bridge yourself with:"
  echo "  $SCRIPT_DIR/start_bridge.sh 2d"
  exit 0
fi

echo "Robot stack is up. Starting the viewer bridge in the foreground."
echo "Ctrl-C stops the bridge; the robot stack keeps running."
echo "Run '$0 --stop' to tear everything down."
echo
exec "$SCRIPT_DIR/start_bridge.sh" 2d
