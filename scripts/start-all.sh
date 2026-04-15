#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

osascript <<EOF
tell application "Terminal"
  do script "cd '$ROOT_DIR' && ./scripts/start-backend.sh"
  do script "cd '$ROOT_DIR' && ./scripts/start-desktop.sh"
end tell
EOF
