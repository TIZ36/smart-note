#!/usr/bin/env bash
# restart-desktop.sh — Kill any running desktop dev session, then start fresh.
#
# Wipes the Vite port (1420) listener and any running Electron child
# processes spawned for this app, then re-runs `npm run electron:dev`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/desktop"

echo "→ stopping any process holding :1420 (Vite)"
PIDS="$(lsof -tiTCP:1420 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "${PIDS}" ]; then
  echo "  killing PID(s): ${PIDS}"
  kill ${PIDS} 2>/dev/null || true
  sleep 1
  PIDS_LEFT="$(lsof -tiTCP:1420 -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "${PIDS_LEFT}" ]; then
    echo "  not exiting cleanly — sending SIGKILL to ${PIDS_LEFT}"
    kill -9 ${PIDS_LEFT} 2>/dev/null || true
  fi
fi

echo "→ stopping any Electron processes for this repo"
# Match electron processes that were launched from this repo's
# desktop/node_modules. Avoids killing unrelated Electron apps.
ELECTRON_PIDS="$(pgrep -f "${DESKTOP_DIR}/node_modules/electron" 2>/dev/null || true)"
if [ -n "${ELECTRON_PIDS}" ]; then
  echo "  killing Electron PID(s): ${ELECTRON_PIDS}"
  kill ${ELECTRON_PIDS} 2>/dev/null || true
fi

cd "$DESKTOP_DIR"

if [ ! -d node_modules ]; then
  echo "→ first run · npm install"
  npm install
fi

echo "→ npm run electron:dev"
exec npm run electron:dev
