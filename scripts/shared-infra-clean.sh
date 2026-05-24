#!/usr/bin/env bash
# =============================================================================
# shared-infra-clean.sh — Drop the worktree's CosmosDB database
# =============================================================================
# Deletes the MongoDB database for this worktree from the shared CosmosDB
# account. Useful to reset state without destroying the entire account.
#
# Usage:
#   ./scripts/shared-infra-clean.sh          # drop this worktree's database
#   ./scripts/shared-infra-clean.sh --yes    # skip confirmation
# =============================================================================
set -euo pipefail

# Get database name from .env (set by worktree-env)
DB_NAME="requests-db"
if [ -f .env ]; then
  FOUND_DB=$(grep "^MONGO_DATABASE=" .env | cut -d= -f2- || true)
  if [ -n "$FOUND_DB" ]; then
    DB_NAME="$FOUND_DB"
  fi
fi

# Get connection string from .env.local (set by shared-infra:use)
if [ ! -f .env.local ]; then
  echo "ERROR: .env.local not found. Run 'pnpm shared-infra:use' first."
  exit 1
fi

CONNECTION_STRING=$(grep "^MONGO_CONNECTION_STRING=" .env.local | cut -d= -f2- || true)
if [ -z "$CONNECTION_STRING" ]; then
  echo "ERROR: MONGO_CONNECTION_STRING not found in .env.local."
  echo "Run 'pnpm shared-infra:use' first."
  exit 1
fi

echo "⚠️  This will DROP the database: $DB_NAME"
echo "   from the shared CosmosDB account."
echo ""

# Confirmation
if [[ "${1:-}" != "--yes" ]] && [[ "${1:-}" != "-y" ]]; then
  read -p "Are you sure? (y/N) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# Drop the database using mongosh or mongoDB shell
echo "→ Dropping database '$DB_NAME'..."

# Try mongosh first, fall back to legacy mongo shell
if command -v mongosh &>/dev/null; then
  mongosh "$CONNECTION_STRING/$DB_NAME" --quiet --eval "db.dropDatabase()"
elif command -v mongo &>/dev/null; then
  mongo "$CONNECTION_STRING/$DB_NAME" --quiet --eval "db.dropDatabase()"
else
  echo "ERROR: Neither 'mongosh' nor 'mongo' found in PATH."
  echo "Install mongosh: https://www.mongodb.com/docs/mongodb-shell/install/"
  exit 1
fi

echo ""
echo "✓ Database '$DB_NAME' dropped."
echo "  It will be re-created automatically on next app start."
