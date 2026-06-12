#!/usr/bin/env bash
# =============================================================================
# shared-infra-use.sh — Activate/deactivate shared infra for this worktree
# =============================================================================
# Reads the connection string from azd's environment at the repo base folder
# and writes it (plus the SCOPE_SHARED_INFRA flag) to .env.local in the
# current worktree. This causes the dev-compose.sh wrapper to skip the local
# MongoDB container and use the shared CosmosDB instead.
#
# Usage:
#   ./scripts/shared-infra-use.sh          # activate
#   ./scripts/shared-infra-use.sh --off    # deactivate
#
# Prerequisites:
#   - azd CLI installed (https://aka.ms/azd)
#   - 'pnpm shared-infra:setup' has been run at least once
# =============================================================================
set -euo pipefail

REPO_BASE="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
LOCAL_ENV=".env.local"

# Keys managed by this script
MANAGED_KEYS=("SCOPE_SHARED_INFRA" "MONGO_CONNECTION_STRING")

# Ensure .azure symlink exists in this worktree (points to repo base)
if [ ! -L .azure ] && [ ! -d .azure ]; then
  ln -sfn "$REPO_BASE/.azure" .azure
elif [ -L .azure ]; then
  ln -sfn "$REPO_BASE/.azure" .azure
fi

# Remove managed keys from .env.local
remove_managed_keys() {
  if [ ! -f "$LOCAL_ENV" ]; then
    return
  fi
  for key in "${MANAGED_KEYS[@]}"; do
    sed -i.bak "/^${key}=/d" "$LOCAL_ENV"
  done
  sed -i.bak '/^# \[shared-infra\]/d' "$LOCAL_ENV"
  rm -f "${LOCAL_ENV}.bak"

  # Remove file if empty (only whitespace/newlines left)
  if [ ! -s "$LOCAL_ENV" ] || ! grep -qP '\S' "$LOCAL_ENV" 2>/dev/null; then
    if ! grep -q '[^[:space:]]' "$LOCAL_ENV" 2>/dev/null; then
      rm -f "$LOCAL_ENV"
    fi
  fi
}

# --- Deactivation ---
if [[ "${1:-}" == "--off" ]]; then
  remove_managed_keys
  echo "✓ Shared infra deactivated. Next docker compose run will use local MongoDB."
  exit 0
fi

# --- Activation ---
# Read connection string from azd environment
CONNECTION_STRING=$(azd env get-value AZURE_COSMOS_CONNECTION_STRING 2>/dev/null) || true

if [ -z "${CONNECTION_STRING:-}" ]; then
  echo "ERROR: Could not read AZURE_COSMOS_CONNECTION_STRING from azd environment."
  echo ""
  echo "Make sure the shared infra has been provisioned:"
  echo "  pnpm shared-infra:setup"
  echo ""
  echo "azd state location: $REPO_BASE/.azure/"
  exit 1
fi

# Remove old managed keys first
remove_managed_keys

# Append managed keys to .env.local
{
  echo ""
  echo "# [shared-infra] Managed by 'pnpm shared-infra:use' — do not edit manually"
  echo "SCOPE_SHARED_INFRA=1"
  echo "MONGO_CONNECTION_STRING=$CONNECTION_STRING"
} >> "$LOCAL_ENV"

# Show the database that will be used (from .env if it exists)
DB_NAME="requests-db"
if [ -f .env ]; then
  FOUND_DB=$(grep "^MONGO_DATABASE=" .env | cut -d= -f2- || true)
  if [ -n "$FOUND_DB" ]; then
    DB_NAME="$FOUND_DB"
  fi
fi

echo "✓ Shared infra activated for this worktree."
echo "  Database: $DB_NAME"
echo "  Connection: ${CONNECTION_STRING:0:40}..."
echo ""
echo "All 'pnpm docker:*' commands will now use CosmosDB (local MongoDB won't start)."
echo "To deactivate: pnpm shared-infra:use --off"
