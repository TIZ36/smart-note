#!/bin/bash
# restart-client.sh — Restart the Electron desktop client
# Handles: npm dependencies, kill old processes, dev or build mode

set -e
cd "$(dirname "$0")/../desktop"

echo "=== SmartNote Client Restart ==="

MODE="${1:-dev}"

# 1. Install/update npm dependencies
echo "[1/3] Checking dependencies..."
if [ ! -d "node_modules" ]; then
    echo "  Installing..."
    npm install
elif [ package.json -nt node_modules/.package-lock.json ] 2>/dev/null; then
    echo "  Updating..."
    npm install
else
    echo "  Dependencies up to date"
fi

# 2. Kill old client processes
echo "[2/3] Stopping old client..."
# Kill Electron
pkill -f "electron \." 2>/dev/null || true
pkill -f "Electron" 2>/dev/null || true
# Kill Vite dev server
OLD_VITE=$(lsof -ti :1420 2>/dev/null || true)
if [ -n "$OLD_VITE" ]; then
    kill $OLD_VITE 2>/dev/null || true
    echo "  Killed Vite (PID $OLD_VITE)"
fi
sleep 1

# 3. Start client
echo "[3/3] Starting client ($MODE mode)..."
if [ "$MODE" = "build" ]; then
    echo "  Building production bundle..."
    npm run electron:build
    echo "=== Build complete (output in desktop/release/) ==="
else
    npm run electron:dev &
    CLIENT_PID=$!

    # Wait for Vite to start
    for i in $(seq 1 20); do
        if curl -s http://127.0.0.1:1420 > /dev/null 2>&1; then
            echo "=== Client running (Vite :1420 + Electron) ==="
            exit 0
        fi
        sleep 1
    done
    echo "=== Client starting (PID $CLIENT_PID) ==="
fi
