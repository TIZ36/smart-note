#!/bin/bash
# restart-docker.sh — Restart the Docker embedding service
# Handles: docker compose up, health check

set -e
cd "$(dirname "$0")"

echo "=== IntelliNote Docker Services Restart ==="

# 1. Check docker is available
if ! command -v docker &> /dev/null; then
    echo "Docker not found. Embedding service requires Docker."
    echo "Install Docker Desktop: https://docker.com/products/docker-desktop"
    exit 1
fi

# 2. Stop existing containers
echo "[1/3] Stopping old containers..."
if [ -f "docker-compose.embedding.yml" ]; then
    docker compose -f docker-compose.embedding.yml down 2>/dev/null || true
else
    echo "  No docker-compose.embedding.yml found, skipping"
    exit 0
fi

# 3. Start containers
echo "[2/3] Starting embedding service..."
docker compose -f docker-compose.embedding.yml up -d

# 4. Health check
echo "[3/3] Waiting for embedding service..."
for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:8009/health > /dev/null 2>&1; then
        echo "=== Embedding service ready ==="
        exit 0
    fi
    sleep 1
done

echo "WARNING: Embedding service not ready after 30s (may still be loading model)"
echo "  Check: docker compose -f docker-compose.embedding.yml logs"
exit 0
