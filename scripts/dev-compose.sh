#!/usr/bin/env bash
# =============================================================================
# dev-compose.sh — Docker Compose wrapper with shared-infra auto-detection
# =============================================================================
# Replaces direct `docker compose` calls in pnpm scripts. Automatically:
#   - Loads .env.local for compose variable interpolation (if it exists)
#   - Adds --profile mongodb (starts local MongoDB) UNLESS SCOPE_SHARED_INFRA=1
#   - Strips 'mongodb' from service arguments when using shared infra
#
# Usage (in package.json scripts):
#   "docker:up": "worktree-env && scripts/dev-compose.sh up --build"
# =============================================================================
set -euo pipefail

# Read SCOPE_SHARED_INFRA flag safely (no source to avoid special char issues)
if [ -f .env.local ]; then
  SCOPE_SHARED_INFRA=$(grep "^SCOPE_SHARED_INFRA=" .env.local | cut -d= -f2- || true)
fi

EXTRA_ARGS=()

# Always pass .env.local for compose variable interpolation (if it exists)
if [ -f .env.local ]; then
  EXTRA_ARGS+=(--env-file .env.local)
fi

# Handle mongodb: add profile OR strip from service args
if [ "${SCOPE_SHARED_INFRA:-}" != "1" ]; then
  EXTRA_ARGS+=(--profile mongodb)
else
  # Strip 'mongodb' from positional args (service names) when using shared infra
  FILTERED_ARGS=()
  for arg in "$@"; do
    if [ "$arg" != "mongodb" ]; then
      FILTERED_ARGS+=("$arg")
    fi
  done
  set -- "${FILTERED_ARGS[@]}"
fi

exec docker compose "${EXTRA_ARGS[@]}" "$@"
