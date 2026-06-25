#!/usr/bin/env bash
# SmartNote Cloud — universal bootstrap.
#
# One script, three flavors:
#
#   ./bootstrap.sh --local
#       Bring up the LAN stack on this machine. Prints URLs other
#       devices on the same Wi-Fi can use. Requires Docker running.
#
#   ./bootstrap.sh --server
#       Production deploy to a clean Linux cloud server. Installs
#       Docker if missing, walks you through .env.prod, brings up
#       the stack behind Caddy (auto Let's Encrypt TLS). Requires
#       DNS already pointing at this server's public IP.
#
#   ./bootstrap.sh          (no args)
#       Auto-detects: macOS / desktop Linux → --local;
#                     headless Linux server  → --server.
#
# Re-run any mode any time — idempotent.
#
# Remote install (server flavor) — single line on a fresh box:
#   curl -fsSL https://raw.githubusercontent.com/<you>/smartnote/main/cloud/infra/bootstrap.sh | bash -s -- --server

set -euo pipefail

MODE="auto"
REPO_URL="${SMARTNOTE_REPO:-https://github.com/<you>/smartnote.git}"
TARGET_DIR="${SMARTNOTE_DIR:-$HOME/smartnote}"

for arg in "$@"; do
  case "$arg" in
    --local)        MODE=local ;;
    --server)       MODE=server ;;
    --repo=*)       REPO_URL="${arg#*=}" ;;
    --dir=*)        TARGET_DIR="${arg#*=}" ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ── helpers ──────────────────────────────────────────────────────
say()  { printf "\033[1;36m▶\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

detect_lan_ip() {
  if command -v ipconfig >/dev/null 2>&1; then
    ipconfig getifaddr en0 2>/dev/null \
      || ipconfig getifaddr en1 2>/dev/null \
      || echo "127.0.0.1"
  else
    hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1"
  fi
}

detect_mode() {
  if [[ "$(uname)" == "Darwin" ]]; then echo local; return; fi
  # Linux desktop heuristic: has $DISPLAY or running locally with sudo creds → likely a workstation.
  if [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]]; then echo local; return; fi
  echo server
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then ok "Docker running"; return; fi
    die "Docker installed but not running. Start Docker Desktop / orbstack / dockerd, then re-run."
  fi
  if [[ "$(uname)" == "Darwin" ]]; then
    die "Install Docker Desktop or OrbStack first: https://www.docker.com/products/docker-desktop"
  fi
  say "Installing Docker (using get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
  command -v docker >/dev/null 2>&1 || die "Docker install failed"
  # `docker compose` plugin ships with the convenience script on most distros.
  if ! docker compose version >/dev/null 2>&1; then
    apt-get install -y docker-compose-plugin 2>/dev/null || die "Install docker-compose-plugin manually"
  fi
  ok "Docker installed"
}

ensure_repo() {
  # Already inside a checkout? Use it.
  if [[ -d "./cloud/infra" ]]; then
    REPO_ROOT="$(pwd)"; return
  fi
  if [[ -d "../infra" && -d "../../cloud/infra" ]]; then
    REPO_ROOT="$(cd ../.. && pwd)"; return
  fi
  if [[ -d "$TARGET_DIR/cloud/infra" ]]; then
    say "Updating existing checkout at $TARGET_DIR"
    git -C "$TARGET_DIR" pull --rebase --autostash || warn "git pull failed; using current checkout"
    REPO_ROOT="$TARGET_DIR"; return
  fi
  say "Cloning $REPO_URL → $TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
  REPO_ROOT="$TARGET_DIR"
}

# ── mode dispatch ────────────────────────────────────────────────
[[ "$MODE" == "auto" ]] && MODE=$(detect_mode)

case "$MODE" in
local)
  say "LAN-mode deploy on this machine"
  ensure_docker
  ensure_repo
  cd "$REPO_ROOT/cloud/infra"
  [[ -f .env ]] || { cp .env.example .env; ok "Created .env from .env.example"; }
  say "Building + starting stack (postgres, embed, api)…"
  docker compose -f docker-compose.lan.yml --env-file .env up -d --build
  say "Waiting for API health…"
  for _ in {1..30}; do
    if curl -fsS "http://localhost:${API_PORT:-58000}/v1/health" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  LAN_IP=$(detect_lan_ip)
  echo
  ok "Stack up. Reach it from any device on this network:"
  echo "    API       http://$LAN_IP:${API_PORT:-58000}"
  echo "    MCP       http://$LAN_IP:${API_PORT:-58000}/mcp"
  echo
  echo "  Point any MCP client or the SDKs at the MCP URL above"
  echo "  and authenticate with your workspace api key."
  echo
  echo "  Issue an admin api key:"
  echo "    docker compose -f docker-compose.lan.yml exec api bash scripts/issue_key.sh"
  ;;

server)
  say "Cloud-server production deploy"
  if [[ $EUID -ne 0 ]] && ! sudo -n true 2>/dev/null; then
    warn "You'll be prompted for sudo to install Docker / open the firewall."
  fi
  ensure_docker
  ensure_repo
  cd "$REPO_ROOT/cloud/infra"

  if [[ ! -f .env.prod ]]; then
    cp .env.prod.example .env.prod
    chmod 600 .env.prod
    say "Created .env.prod from template — answer a few questions:"
    read -rp "  API domain     (e.g. api.example.com): "     API_DOMAIN
    read -rp "  ACME email     (Let's Encrypt notifications): " ACME_EMAIL
    PG_PASS=$(openssl rand -base64 32 | tr -d '=+/')
    JWT_SEC=$(openssl rand -hex 32)
    sed -i.bak \
      -e "s|^API_DOMAIN=.*|API_DOMAIN=$API_DOMAIN|" \
      -e "s|^ACME_EMAIL=.*|ACME_EMAIL=$ACME_EMAIL|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PG_PASS|" \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SEC|" \
      .env.prod
    rm -f .env.prod.bak
    ok ".env.prod populated (secrets auto-generated)"
  else
    ok ".env.prod already exists, leaving as-is"
  fi
  ./deploy.sh up
  ;;

*) die "unknown mode: $MODE" ;;
esac
