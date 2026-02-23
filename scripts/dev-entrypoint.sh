#!/bin/bash
set -e

# Dev entrypoint: runs shared package tsc --watch in the background,
# then starts the service with tsx watch for hot reload.
#
# Required env var:
#   SERVICE_DIR - relative path from /app/apps/ (e.g., "api", "judge", "workers/coder-acp-copilot")

if [ -z "$SERVICE_DIR" ]; then
  echo "ERROR: SERVICE_DIR env var is required"
  exit 1
fi

echo "[dev-entrypoint] Starting shared package watcher..."
cd /app/packages/shared && npx tsc --watch --preserveWatchOutput &

echo "[dev-entrypoint] Starting $SERVICE_DIR with tsx watch..."
cd /app/apps/$SERVICE_DIR
exec npx tsx watch src/index.ts
