#!/usr/bin/env bash
# =============================================================================
# worktree-env.sh — Wrapper around worktree-env that enforces name limits
# =============================================================================
# MongoDB database names must be at most 63 characters. The worktree-env tool
# appends the full worktree directory name to string values (like MONGO_DATABASE),
# which can exceed this limit with long branch names.
#
# This wrapper runs worktree-env normally, then truncates MONGO_DATABASE in .env
# to 63 characters (using a hash suffix for uniqueness when truncation is needed).
# =============================================================================
set -euo pipefail

MONGO_DB_MAX_LENGTH=63

# Run the real worktree-env
npx worktree-env "$@"

# Check if .env exists and MONGO_DATABASE exceeds the limit
ENV_FILE="${1:-.env}"
if [ -f ".env" ]; then
  ENV_FILE=".env"
fi

CURRENT_DB=$(grep "^MONGO_DATABASE=" "$ENV_FILE" | cut -d= -f2- || true)

if [ -z "$CURRENT_DB" ]; then
  exit 0
fi

DB_LENGTH=${#CURRENT_DB}

if [ "$DB_LENGTH" -gt "$MONGO_DB_MAX_LENGTH" ]; then
  # Truncate with a short hash suffix for uniqueness
  HASH=$(echo -n "$CURRENT_DB" | shasum -a 256 | cut -c1-8)
  # Leave room for -<hash> (9 chars)
  TRUNCATE_TO=$((MONGO_DB_MAX_LENGTH - 9))
  TRUNCATED="${CURRENT_DB:0:$TRUNCATE_TO}-${HASH}"

  # Replace in .env using a portable sed command
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|^MONGO_DATABASE=.*|MONGO_DATABASE=${TRUNCATED}|" "$ENV_FILE"
  else
    sed -i "s|^MONGO_DATABASE=.*|MONGO_DATABASE=${TRUNCATED}|" "$ENV_FILE"
  fi

  echo "[worktree-env] Truncated MONGO_DATABASE to ${#TRUNCATED} chars (was $DB_LENGTH): $TRUNCATED"
fi
