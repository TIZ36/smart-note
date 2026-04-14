#!/bin/bash
# restart-all.sh — Restart all IntelliNote services
# Usage: ./restart-all.sh [--with-docker]

set -e
cd "$(dirname "$0")"

echo "======================================="
echo "  IntelliNote Full Restart"
echo "======================================="
echo ""

# Optional: restart docker embedding service
if [ "$1" = "--with-docker" ]; then
    bash restart-docker.sh
    echo ""
fi

# Restart backend (includes DB migration)
bash restart-server.sh
echo ""

# Restart client
bash restart-client.sh
echo ""

echo "======================================="
echo "  All services started"
echo "======================================="
