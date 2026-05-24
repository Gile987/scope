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

# Extract account name from connection string (format: mongodb://ACCOUNT-NAME:key@HOST:PORT/...)
ACCOUNT_NAME=$(echo "$CONNECTION_STRING" | sed -n 's|^mongodb://\([^:]*\):.*|\1|p')

# Get subscription from azd environment, then resolve names via az cli
AZURE_SUBSCRIPTION_ID=$(azd env get-value AZURE_SUBSCRIPTION_ID 2>/dev/null || true)
SUBSCRIPTION_NAME=""
TENANT_NAME=""
if [ -n "$AZURE_SUBSCRIPTION_ID" ]; then
  SUBSCRIPTION_NAME=$(az account show --subscription "$AZURE_SUBSCRIPTION_ID" --query "name" -o tsv 2>/dev/null || true)
  TENANT_NAME=$(az account show --subscription "$AZURE_SUBSCRIPTION_ID" --query "tenantDisplayName" -o tsv 2>/dev/null || true)
fi

echo "⚠️  This will DROP the database from the shared CosmosDB account."
echo ""
echo "   Tenant:       ${TENANT_NAME:-unknown}"
echo "   Subscription: ${SUBSCRIPTION_NAME:-$AZURE_SUBSCRIPTION_ID}"
echo "   Account:      ${ACCOUNT_NAME:-unknown}"
echo "   Database:     $DB_NAME"
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

# Drop the database using the mongodb driver (resolved from packages/shared)
echo "→ Dropping database '$DB_NAME'..."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED_DIR="$SCRIPT_DIR/../packages/shared"

CONNECTION_STRING="$CONNECTION_STRING" DB_NAME="$DB_NAME" node --input-type=module --eval "
import { createRequire } from 'module';
const require = createRequire('$SHARED_DIR/package.json');
const { MongoClient } = require('mongodb');
const client = new MongoClient(process.env.CONNECTION_STRING);
await client.connect();
await client.db(process.env.DB_NAME).dropDatabase();
await client.close();
console.log('Done.');
"

echo ""
echo "✓ Database '$DB_NAME' dropped."
echo "  It will be re-created automatically on next app start."
