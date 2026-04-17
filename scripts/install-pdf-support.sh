#!/bin/bash
# install-pdf-support.sh — Install optional PDF / URL-import / OCR dependencies.
# These are ~250 MB extra (sympy, onnxruntime, magika, pdfminer, PIL).
# Install only if you need PDF import or scanned-doc OCR.

set -e
cd "$(dirname "$0")/../server"

if [ ! -d ".venv" ]; then
    echo "ERROR: run ./scripts/restart-server.sh first to create .venv"
    exit 1
fi

echo "=== Installing optional PDF / OCR dependencies ==="
echo "This may take 1–3 minutes."
.venv/bin/pip install -r requirements-optional.txt
echo "$(shasum -a 256 requirements-optional.txt | awk '{print $1}')" > .venv/.reqs-optional.sha

echo ""
echo "Done. You may also need system binaries:"
echo "  macOS:  brew install tesseract poppler"
echo "  Ubuntu: apt install tesseract-ocr poppler-utils"
