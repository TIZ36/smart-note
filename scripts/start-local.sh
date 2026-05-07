#!/usr/bin/env bash
# SmartNote — one-click local-mode launcher.
#
# Brings up the only docker dependency (embed service) + the
# desktop electron app. No cloud, no log-panel, no postgres.
#
# Usage:
#   ./scripts/start-local.sh           # default: embed + desktop dev
#   ./scripts/start-local.sh --no-embed   # skip docker, dev only
#   ./scripts/start-local.sh --build     # rebuild embed image first

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/cloud/infra"
DESKTOP_DIR="$ROOT_DIR/desktop"

NO_EMBED=0
BUILD=0
for arg in "$@"; do
  case "$arg" in
    --no-embed) NO_EMBED=1 ;;
    --build)    BUILD=1 ;;
    --help|-h)
      sed -n '2,12p' "$0"; exit 0 ;;
  esac
done

color() { printf "\033[%sm%s\033[0m" "$1" "$2"; }
info() { color "1;34" "▶ $*"; echo; }
ok()   { color "1;32" "✓ $*"; echo; }
warn() { color "1;33" "! $*"; echo; }
die()  { color "1;31" "✗ $*"; echo; exit 1; }

# ── 1. embed service (the only docker dep) ──────────────────────
if [ "$NO_EMBED" -eq 0 ]; then
  info "Checking docker"
  if ! command -v docker >/dev/null 2>&1; then
    die "docker not found. Install Docker Desktop, or pass --no-embed if you'll run embed elsewhere."
  fi
  if ! docker info >/dev/null 2>&1; then
    die "docker daemon not running. Open Docker Desktop and retry."
  fi

  info "Starting embed service (cloud/infra/docker-compose.yml → embed)"
  cd "$INFRA_DIR"
  if [ "$BUILD" -eq 1 ]; then
    docker compose build embed
  fi
  docker compose up -d embed

  # Read host-published port from `docker compose port`; falls back
  # to .env's EMBED_PORT, then 8009. The user's .env may remap to
  # avoid conflicts (e.g. EMBED_PORT=58009 in this user's setup).
  EMBED_PORT="$(docker compose port embed 8009 2>/dev/null | sed -E 's/.*:([0-9]+)$/\1/' | head -1)"
  if [ -z "$EMBED_PORT" ]; then
    if [ -f .env ]; then
      EMBED_PORT="$(grep -E '^EMBED_PORT=' .env | cut -d= -f2- | head -1)"
    fi
  fi
  EMBED_PORT="${EMBED_PORT:-8009}"
  EMBED_URL="http://localhost:${EMBED_PORT}"
  export EMBED_URL                # propagate to electron main process
  info "embed published at ${EMBED_URL}"

  info "Waiting for ${EMBED_URL}/health"
  for i in $(seq 1 60); do
    if curl -fsS "${EMBED_URL}/health" >/dev/null 2>&1; then
      ok "embed reachable"
      break
    fi
    if [ "$i" -eq 60 ]; then
      warn "embed didn't pass /health after 60s — desktop will start anyway, chunk_embed will fail until it's up"
      break
    fi
    sleep 1
  done
else
  EMBED_URL="${EMBED_URL:-http://localhost:8009}"
  export EMBED_URL
  warn "Skipping embed (--no-embed). Using EMBED_URL=${EMBED_URL}"
fi

# ── 2. desktop electron dev ─────────────────────────────────────
cd "$DESKTOP_DIR"

if [ ! -d node_modules ]; then
  info "Installing desktop deps"
  npm install
fi

# Ensure local-mode is the default for the launcher. The user can
# still flip it off in Settings → Cloud at runtime; we only seed
# the value when it's never been set.
SETTINGS_DIR="${HOME}/Library/Application Support/SmartNote"
if [ -d "$SETTINGS_DIR" ] && [ -f "$SETTINGS_DIR/settings.json" ]; then
  if ! grep -q '"local_mode"' "$SETTINGS_DIR/settings.json" 2>/dev/null; then
    info "Seeding local_mode=true in settings.json"
    # crude but works — append a key before the closing brace
    tmp=$(mktemp)
    python3 -c "
import json, sys
p = '$SETTINGS_DIR/settings.json'
try:
  d = json.load(open(p))
except Exception:
  d = {}
d.setdefault('local_mode', True)
json.dump(d, open(p, 'w'), indent=2)
" || warn "couldn't seed local_mode (keep going; default in code is true anyway)"
  fi
fi

info "Starting desktop (electron + vite)"
exec npm run electron:dev
