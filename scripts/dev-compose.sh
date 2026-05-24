#!/usr/bin/env bash
# =============================================================================
# dev-compose.sh — Docker Compose wrapper with shared-infra auto-detection
# =============================================================================
# Replaces direct `docker compose` calls in pnpm scripts. Automatically:
#   - Loads .env.local for compose variable interpolation (if it exists)
#   - Adds --profile mongodb (starts local MongoDB) UNLESS SCOPE_SHARED_INFRA=1
#
# Usage (in package.json scripts):
#   "docker:up": "worktree-env && scripts/dev-compose.sh up --build"
# =============================================================================
set -euo pipefail

# Source .env.local to read SCOPE_SHARED_INFRA flag
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

EXTRA_ARGS=()

# Always pass .env.local for compose variable interpolation (if it exists)
if [ -f .env.local ]; then
  EXTRA_ARGS+=(--env-file .env.local)
fi

# Only start local mongodb if NOT using shared infra
if [ "${SCOPE_SHARED_INFRA:-}" != "1" ]; then
  EXTRA_ARGS+=(--profile mongodb)
fi

exec docker compose "${EXTRA_ARGS[@]}" "$@"
