#!/usr/bin/env bash
# clean-all-data.sh — Wipe ALL local SmartNote state.
#
# Wipes:
#   1. Cloud postgres volume (docker compose down -v)
#   2. Cloud generated artifacts (cloud/data/, cloud/.cache/ if present)
#   3. Legacy server/data/ from the retired local Python pipeline
#
# Confirms before deleting. Pass --yes to skip the prompt.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    --help|-h)
      sed -n '2,11p' "$0"
      exit 0
      ;;
  esac
done

echo "=== SmartNote · Clean ALL data ==="
echo
echo "Will delete:"
echo "  1. Cloud postgres data        (docker compose down -v in cloud/infra)"
echo "  2. Cloud generated artifacts  ($REPO_ROOT/cloud/data, .cache)"
echo "  3. Legacy server/data/        ($REPO_ROOT/server/data — if present)"
echo

if [ "$YES" -ne 1 ]; then
  read -p "Are you sure? (y/N) " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Cancelled."
    exit 0
  fi
fi

echo
echo "→ 1. cloud postgres + named volumes"
if [ -d "$REPO_ROOT/cloud/infra" ] && command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    (cd "$REPO_ROOT/cloud/infra" && docker compose down -v) || true
  else
    echo "   docker daemon not running — skipping volume drop"
  fi
else
  echo "   skipped (no docker / no cloud/infra)"
fi

echo "→ 2. cloud/data + cloud/.cache"
rm -rf "$REPO_ROOT/cloud/data" "$REPO_ROOT/cloud/.cache" 2>/dev/null || true

echo "→ 3. legacy server/data"
rm -rf "$REPO_ROOT/server/data"          2>/dev/null || true
rm -rf "$REPO_ROOT/sample/views"         2>/dev/null || true
rm -rf "$REPO_ROOT/sample/candidates"    2>/dev/null || true
rm -f  "$REPO_ROOT/sample/note.md"       2>/dev/null || true
rm -f  "$REPO_ROOT/sample/.state.json"   2>/dev/null || true

echo
echo "✓ All data wiped."
echo "  Next:"
echo "    ./scripts/restart-cloud.sh    # bring cloud back with empty schema"
