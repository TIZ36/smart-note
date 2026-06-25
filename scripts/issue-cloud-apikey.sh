#!/usr/bin/env bash
# issue-cloud-apikey.sh — Mint a SmartNote Cloud API key.
#
# Wrapper around cloud/scripts/issue_key.sh that adds a friendly
# health-check and lives at the same level as the other top-level
# scripts (restart-cloud / clean-all-data).
#
# Prereqs:
#   - Cloud stack is up (./scripts/restart-cloud.sh)
#   - ALLOW_DEV_BOOTSTRAP=true in cloud/infra/.env
#
# Usage:
#   ./scripts/issue-cloud-apikey.sh                  # default workspace name
#   ./scripts/issue-cloud-apikey.sh my-workspace     # custom name
#   BASE=http://1.2.3.4:58000 ./scripts/issue-cloud-apikey.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DELEGATE="$REPO_ROOT/cloud/scripts/issue_key.sh"
BASE="${BASE:-http://localhost:58000}"

if [ ! -x "$DELEGATE" ]; then
  echo "✗ missing $DELEGATE — is this the right repo root?" >&2
  exit 1
fi

# Pre-flight: surface a clearer error than the delegate's curl failure
# would give if the cloud isn't running.
if ! curl -fsS "$BASE/v1/health" >/dev/null 2>&1; then
  echo "✗ Cloud API not reachable at $BASE" >&2
  echo "  Bring it up first: ./scripts/restart-cloud.sh" >&2
  exit 1
fi

# Pass through any args (workspace name) and the BASE env var.
exec "$DELEGATE" "$@"
