#!/bin/bash
# restart-server.sh — Restart the Python FastAPI backend
# Handles: venv, hash-skip pip install, DB migration, kill + start

set -e
cd "$(dirname "$0")/../server"

echo "=== SmartNote Server Restart ==="

REQS="requirements.txt"
REQS_HASH_FILE=".venv/.reqs.sha"

# 1. Ensure venv exists
if [ ! -d ".venv" ]; then
    echo "[1/4] Creating virtual environment..."
    python3 -m venv .venv
    rm -f "$REQS_HASH_FILE"  # force install on fresh venv
else
    echo "[1/4] Virtual environment exists"
fi

# 2. Install deps only if requirements.txt changed
CURRENT_HASH=$(shasum -a 256 "$REQS" | awk '{print $1}')
STORED_HASH=$(cat "$REQS_HASH_FILE" 2>/dev/null || echo "")

if [ "$CURRENT_HASH" != "$STORED_HASH" ]; then
    echo "[2/4] Installing core dependencies..."
    .venv/bin/pip install -q -r "$REQS" 2>&1 | tail -1
    echo "$CURRENT_HASH" > "$REQS_HASH_FILE"
else
    echo "[2/4] Dependencies up to date (hash match)"
fi

# 3. Kill old server process
echo "[3/4] Stopping old server..."
OLD_PID=$(lsof -ti :8787 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
    kill $OLD_PID 2>/dev/null || true
    sleep 1
    kill -9 $OLD_PID 2>/dev/null || true
    echo "  Killed PID $OLD_PID"
else
    echo "  No server running on port 8787"
fi

# 4. Run DB migration + start server
echo "[4/4] Migrating DB and starting server..."
.venv/bin/python -c "from app.db import init_db, migrate_db; init_db(); migrate_db(); print('  DB migrated')"
.venv/bin/python -m app.cli serve --port 8787 &
SERVER_PID=$!

for i in $(seq 1 20); do
    if curl -s http://127.0.0.1:8787/health > /dev/null 2>&1; then
        echo "=== Server running (PID $SERVER_PID) ==="
        echo "  Health: $(curl -s http://127.0.0.1:8787/health)"
        exit 0
    fi
    sleep 0.5
done

echo "ERROR: Server failed to start within 10s"
exit 1
