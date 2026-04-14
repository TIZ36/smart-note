#!/bin/bash
# cleanalldata.sh — Delete all IntelliNote data (DB, views, versions, tags, prefs)
# The next restart-server.sh will create a fresh empty database.

set -e
cd "$(dirname "$0")"

echo "=== IntelliNote Clean All Data ==="
echo ""
echo "This will delete:"
echo "  - SQLite database (data/app.db)"
echo "  - Knowledge base versions (data/versions/)"
echo "  - Tag configuration (data/tags.json)"
echo "  - Hotkey/prefs config (data/prefs.json, data/hotkey.json)"
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

rm -rf data/
rm -rf sample/views/
rm -rf sample/candidates/
rm -f sample/note.md
rm -f sample/.state.json

echo "Done. Run ./restart-server.sh to create a fresh database."
