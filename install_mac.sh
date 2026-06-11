#!/usr/bin/env bash
# Install dependencies for development on the Mac: bridge (mock) + web viewer.
# No ROS2 involved. Idempotent — safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== robot_gui install (mac) =="

# --- bridge (Python) --------------------------------------------------------
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found — install Python 3.11+ first (brew install python)." >&2
    exit 1
fi

if command -v uv &>/dev/null; then
    echo "-- bridge: syncing with uv"
    (cd "$SCRIPT_DIR/bridge" && uv sync --group dev)
else
    echo "-- bridge: uv not found, using python3 venv at bridge/.venv-mock"
    VENV="$SCRIPT_DIR/bridge/.venv-mock"
    [[ -x "$VENV/bin/python" ]] || python3 -m venv "$VENV"
    "$VENV/bin/pip" install --quiet --upgrade pip
    "$VENV/bin/pip" install --quiet -e "$SCRIPT_DIR/bridge"
fi

# --- web viewer (Node) ------------------------------------------------------
if ! command -v npm &>/dev/null; then
    echo "ERROR: npm not found — install Node.js 20+ first (brew install node)." >&2
    exit 1
fi
echo "-- web: npm install"
(cd "$SCRIPT_DIR/web" && npm install --no-fund --no-audit)

echo
echo "Done. Next steps:"
echo "  ./start_bridge.sh mock          # terminal 1 — mock data generator"
echo "  cd web && npm run dev           # terminal 2 — viewer at http://localhost:5173"
