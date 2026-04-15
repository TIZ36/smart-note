#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../desktop"

npm install
npm run electron:dev
