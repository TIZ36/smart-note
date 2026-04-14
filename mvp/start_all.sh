#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

osascript <<EOF
tell application "Terminal"
  do script "cd '$ROOT_DIR' && ./start_backend.sh"
  do script "cd '$ROOT_DIR' && ./start_desktop.sh"
end tell
EOF
