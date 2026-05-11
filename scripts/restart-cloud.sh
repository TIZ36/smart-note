#!/usr/bin/env bash
# restart-cloud.sh — Rebuild + restart the SmartNote cloud API.
#
# Restarts the docker compose api service (postgres + embed stay up).
# Pass --full to recreate the entire stack.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/cloud/infra"

FULL=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --help|-h)
      sed -n '2,7p' "$0"
      exit 0
      ;;
  esac
done

if [ ! -f .env ]; then
  echo "→ creating cloud/infra/.env from .env.example"
  cp .env.example .env
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker not found. Install Docker Desktop and retry." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "✗ docker daemon not running. Open Docker Desktop and retry." >&2
  exit 1
fi

if [ "$FULL" -eq 1 ]; then
  echo "→ recreating full stack (postgres + embed + api)"
  docker compose down
  docker compose up -d --build
else
  echo "→ rebuilding + restarting api only (postgres/embed stay up)"
  docker compose up -d --build api
fi

PORT="${API_PORT:-58000}"
echo "→ waiting for /v1/health on :${PORT} (up to 90s)"
for i in $(seq 1 90); do
  if curl -fsS "http://localhost:${PORT}/v1/health" >/dev/null 2>&1; then
    echo "✓ api healthy after ${i}s"
    exit 0
  fi
  sleep 1
done
echo "✗ api did not become healthy in 90s. Last 30 log lines:" >&2
docker compose logs --tail 30 api >&2
exit 1
