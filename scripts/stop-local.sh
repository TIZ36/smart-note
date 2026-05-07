#!/usr/bin/env bash
# Stop the local-mode stack — bring down embed cleanly. Electron
# is interactive; just close its window.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/cloud/infra"

color() { printf "\033[%sm%s\033[0m" "$1" "$2"; }
info() { color "1;34" "▶ $*"; echo; }
ok()   { color "1;32" "✓ $*"; echo; }

cd "$INFRA_DIR"

info "Stopping embed service"
docker compose stop embed >/dev/null 2>&1 || true
ok "embed stopped"

# Note: postgres / api / log-panel are not started by start-local.sh,
# so we don't touch them here. If you previously ran cloud and want
# to bring everything down, run `cd cloud/infra && docker compose down`.
