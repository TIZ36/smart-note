#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../server"

if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
fi

source .venv/bin/activate
pip install -r requirements.txt

if [[ ! -f ".env" ]]; then
  cp .env.example .env
fi

python -m app.cli init-db
python -m app.cli serve --port 8787
