#!/usr/bin/env bash
# SmartNote Cloud quickstart — one command from clean repo to working demo.
#
# Usage:
#   ./cloud/scripts/quickstart.sh
#
# What it does:
#   1. cp cloud/infra/.env.example → cloud/infra/.env (if not present)
#   2. docker compose up -d (build + start postgres + embed + api)
#   3. wait for /v1/health to return 200
#   4. python cloud/scripts/demo.py — runs the end-to-end smoke test

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT/cloud/infra"

if [ ! -f .env ]; then
  echo "→ creating cloud/infra/.env from .env.example"
  cp .env.example .env
fi

echo "→ bringing up docker compose stack (this builds the embed image on first run — ~5 min)"
docker compose up -d --build

echo "→ waiting for api health (up to 2 min — embed model download is the slow part)"
for i in $(seq 1 120); do
  if curl -fsS "http://localhost:${API_PORT:-58000}/v1/health" >/dev/null 2>&1; then
    echo "✓ api is healthy after ${i}s"
    break
  fi
  if [ "$i" -eq 120 ]; then
    echo "❌ api did not become healthy. Logs:"
    docker compose logs --tail 50 api
    exit 1
  fi
  sleep 1
done

echo "→ running end-to-end demo"
cd "$REPO_ROOT"
python3 -m pip install --quiet httpx >/dev/null
BASE="http://localhost:${API_PORT:-58000}" python3 cloud/scripts/demo.py

cat <<'EOF'

Next steps:
  • Tear down:   cd cloud/infra && docker compose down
  • Wipe DB:     cd cloud/infra && docker compose down -v
  • Logs:        cd cloud/infra && docker compose logs -f api
EOF
