#!/bin/bash
# restart-all.sh — Restart all SmartNote services
# Usage: ./scripts/restart-all.sh [--with-docker]

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "======================================="
echo "  SmartNote Full Restart"
echo "======================================="
echo ""

# Optional: restart docker embedding service
if [ "${1:-}" = "--with-docker" ]; then
    bash "$SCRIPT_DIR/restart-docker.sh"
    echo ""
fi

# Restart backend (includes DB migration)
bash "$SCRIPT_DIR/restart-server.sh"
echo ""

# Restart client
bash "$SCRIPT_DIR/restart-client.sh"
echo ""

echo "======================================="
echo "  All services started"
echo "======================================="
