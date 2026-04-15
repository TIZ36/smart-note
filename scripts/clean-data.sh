#!/bin/bash
# clean-data.sh — Delete all SmartNote data (DB, views, versions, tags, prefs)
# The next restart-server.sh will create a fresh empty database.

set -e
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== SmartNote Clean All Data ==="
echo ""
echo "This will delete:"
echo "  - SQLite database (server/data/app.db)"
echo "  - Knowledge base versions (server/data/versions/)"
echo "  - Tag configuration (server/data/tags.json)"
echo "  - Hotkey/prefs config (server/data/prefs.json, server/data/hotkey.json)"
echo "  - Generated views (sample/views/, sample/note.md, sample/.state.json)"
echo "  - Generated candidates (sample/candidates/)"
echo ""
read -p "Are you sure? (y/N) " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Cancelled."
    exit 0
fi

echo ""
echo "Cleaning..."

rm -rf "$ROOT_DIR/server/data/"
rm -rf "$ROOT_DIR/sample/views/"
rm -rf "$ROOT_DIR/sample/candidates/"
rm -f "$ROOT_DIR/sample/note.md"
rm -f "$ROOT_DIR/sample/.state.json"

echo "Done. Run ./scripts/restart-server.sh to create a fresh database."
