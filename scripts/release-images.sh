#!/usr/bin/env bash
# release-images.sh — Build images and push them to a container registry.
#
# Publishes two images (Postgres uses the public pgvector image as-is, so
# it is NOT republished):
#   ${IMAGE_PREFIX}-api:${TAG}     (+ :latest)
#   ${IMAGE_PREFIX}-embed:${TAG}   (+ :latest)
#
# Defaults target the Docker Hub namespace `ztzsyy`. Override via env:
#   IMAGE_PREFIX=you/smartnote IMAGE_TAG=v1 PLATFORM=linux/amd64 \
#     ./scripts/release-images.sh
#
# Cross-arch note: builds for linux/amd64 by default so the images run on
# a typical x86_64 cloud server even when you build on an Apple-silicon
# Mac. Set PLATFORM=linux/arm64 (or linux/amd64,linux/arm64 for both) if
# your server is ARM.
#
# Prereqs: docker buildx (ships with modern Docker) and a prior
#   docker login   (to Docker Hub, or your registry)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE_PREFIX="${IMAGE_PREFIX:-ztzsyy/smartnote}"
PLATFORM="${PLATFORM:-linux/amd64}"
if [ -n "${IMAGE_TAG:-}" ]; then
  TAG="$IMAGE_TAG"
elif git rev-parse --short HEAD >/dev/null 2>&1; then
  TAG="$(git rev-parse --short HEAD)"
else
  TAG="latest"
fi

echo "▶ registry prefix : ${IMAGE_PREFIX}"
echo "▶ tag             : ${TAG} (also tags :latest)"
echo "▶ platform        : ${PLATFORM}"
echo

# A docker-container builder is required for --platform cross-builds and
# for pushing a manifest in one pass. Create once, reuse after.
BUILDER=smartnote-builder
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "→ creating buildx builder '${BUILDER}'"
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null
fi
docker buildx use "$BUILDER"

echo "▶ building + pushing api …"
docker buildx build --platform "$PLATFORM" \
  -f cloud/api/Dockerfile \
  -t "${IMAGE_PREFIX}-api:${TAG}" \
  -t "${IMAGE_PREFIX}-api:latest" \
  --push \
  cloud

echo "▶ building + pushing embed …"
docker buildx build --platform "$PLATFORM" \
  -f local_embedding/Dockerfile \
  -t "${IMAGE_PREFIX}-embed:${TAG}" \
  -t "${IMAGE_PREFIX}-embed:latest" \
  --push \
  local_embedding

echo
echo "✓ pushed:"
echo "    ${IMAGE_PREFIX}-api:${TAG}    (+ latest)"
echo "    ${IMAGE_PREFIX}-embed:${TAG}  (+ latest)"
echo
echo "On the server (only needs docker-compose.deploy.yml + .env):"
echo "    docker compose -f docker-compose.deploy.yml --env-file .env pull"
echo "    docker compose -f docker-compose.deploy.yml --env-file .env up -d"
