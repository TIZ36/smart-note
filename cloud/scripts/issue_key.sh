#!/usr/bin/env bash
# Mint a SmartNote Cloud API key and print it (plus a copy-pasteable
# export line so you can drop it straight into your shell / MCP config).
#
# Prereqs: the stack is up (`./cloud/scripts/quickstart.sh` or
# `docker compose up -d` in cloud/infra/) and ALLOW_DEV_BOOTSTRAP=true.
#
# Usage:
#   ./cloud/scripts/issue_key.sh                     # default workspace name
#   ./cloud/scripts/issue_key.sh my-workspace        # custom name
#   BASE=http://1.2.3.4:58000 ./cloud/scripts/issue_key.sh

set -euo pipefail

BASE="${BASE:-http://localhost:58000}"
NAME="${1:-workspace-$(date +%s)}"
SLUG="$(echo "$NAME" | tr '[:upper:] ' '[:lower:]-' | tr -cd '[:alnum:]-')"

if ! curl -fsS "$BASE/v1/health" >/dev/null 2>&1; then
  echo "❌ API not reachable at $BASE — is the stack up?" >&2
  echo "   run: ./cloud/scripts/quickstart.sh" >&2
  exit 1
fi

RESP="$(curl -fsS -X POST "$BASE/v1/dev/bootstrap" \
  -H 'Content-Type: application/json' \
  -d "{
    \"tenant_name\": \"$NAME\",
    \"workspace_name\": \"$NAME\",
    \"workspace_slug\": \"$SLUG\",
    \"api_key_name\": \"$NAME-key\"
  }")"

# POSIX-y JSON extraction — no jq dependency. Good enough for two fields.
WS_ID="$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["workspace"]["id"])')"
SECRET="$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["api_key"]["secret"])')"

cat <<EOF

✓ Minted new API key

  workspace_id: $WS_ID
  api_key:      $SECRET

Save it now — the API never shows the secret again.

For MCP clients (Cursor / Claude Code / OpenCode), paste:

  "env": {
    "SMARTNOTE_API_KEY": "$SECRET",
    "SMARTNOTE_BASE_URL": "$BASE"
  }

Or export into your shell for quick scripting:

  export SMARTNOTE_API_KEY='$SECRET'
  export SMARTNOTE_BASE_URL='$BASE'

EOF
