#!/usr/bin/env bash
# SmartNote Cloud — production deploy / update.
# Idempotent: safe to re-run for updates (pulls latest source, rebuilds,
# rolling-restarts containers, preserves pgdata and Caddy certs).
#
# Prereqs on the server (first time only):
#   - docker + docker-compose-plugin installed
#   - this repo cloned and current dir
#   - .env.prod created from .env.prod.example with real values
#   - DNS A records for $API_DOMAIN and $CONSOLE_DOMAIN pointing here
#   - ports 80 + 443 open in the cloud provider's firewall
#
# Usage:
#   ./deploy.sh            # build + up -d
#   ./deploy.sh logs       # tail aggregated logs
#   ./deploy.sh restart    # rolling restart, no rebuild
#   ./deploy.sh stop       # bring everything down (keeps volumes)
#   ./deploy.sh bootstrap  # one-time: create admin api_key after first deploy

set -euo pipefail
cd "$(dirname "$0")"

COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"
ACTION="${1:-up}"

require_env() {
  if [[ ! -f .env.prod ]]; then
    echo "✗ .env.prod missing — copy .env.prod.example and fill in real values" >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  set -a; source .env.prod; set +a
  for v in API_DOMAIN CONSOLE_DOMAIN ACME_EMAIL POSTGRES_PASSWORD JWT_SECRET; do
    if [[ -z "${!v:-}" || "${!v}" == CHANGE_ME* ]]; then
      echo "✗ .env.prod: $v must be set to a real value" >&2; exit 1
    fi
  done
}

case "$ACTION" in
  up|"")
    require_env
    echo "▶ building images …"
    $COMPOSE build --pull
    echo "▶ starting stack …"
    $COMPOSE up -d
    echo "▶ waiting for api health …"
    for i in {1..30}; do
      if $COMPOSE exec -T api curl -fsS http://localhost:8000/v1/health >/dev/null 2>&1; then
        echo "✓ api healthy"
        break
      fi
      sleep 2
    done
    echo
    echo "✓ deployed."
    echo "  console  https://$CONSOLE_DOMAIN"
    echo "  api      https://$API_DOMAIN"
    echo "  mcp      https://$API_DOMAIN/mcp"
    echo
    echo "Next: ./deploy.sh bootstrap   (only if this is a fresh deploy)"
    ;;
  logs)     require_env; $COMPOSE logs -f --tail=200 ;;
  restart)  require_env; $COMPOSE restart ;;
  stop)     require_env; $COMPOSE down ;;
  ps)       require_env; $COMPOSE ps ;;
  bootstrap)
    require_env
    echo "▶ Issuing a first admin api key …"
    echo "  (Requires ALLOW_DEV_BOOTSTRAP=true in .env.prod for this one step;"
    echo "   set it back to false and ./deploy.sh restart afterwards.)"
    if [[ "${ALLOW_DEV_BOOTSTRAP:-false}" != "true" ]]; then
      echo "✗ ALLOW_DEV_BOOTSTRAP is not true — flip it, redeploy, then re-run bootstrap" >&2
      exit 1
    fi
    curl -fsS -X POST "https://$API_DOMAIN/v1/dev/bootstrap" \
      -H 'Content-Type: application/json' \
      -d '{"tenant_name":"admin","workspace_name":"default"}' | python3 -m json.tool
    echo
    echo "✓ Save the api_key above — it will not be shown again."
    echo "  Flip ALLOW_DEV_BOOTSTRAP=false in .env.prod and ./deploy.sh restart."
    ;;
  *)
    echo "Usage: $0 [up|logs|restart|stop|ps|bootstrap]"; exit 2 ;;
esac
