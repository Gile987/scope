#!/usr/bin/env bash
# =============================================================================
# shared-infra-setup.sh — Deploy a shared dev CosmosDB for MongoDB account
# =============================================================================
# One-time setup per team. Uses Azure Developer CLI (azd) to provision a
# serverless CosmosDB account. The azd environment state (.azure/) is stored
# at the repo base folder so all worktrees can access it.
#
# Usage:
#   ./scripts/shared-infra-setup.sh
#
# Prerequisites:
#   - azd CLI installed (https://aka.ms/azd)
#   - Logged in: azd auth login
# =============================================================================
set -euo pipefail

REPO_BASE="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"

echo "=== Shared Infrastructure Setup (azd) ==="
echo "  Repo base: $REPO_BASE"
echo "  azd state: $REPO_BASE/.azure/"
echo ""

# Ensure .azure/ lives at the repo base (shared across worktrees)
mkdir -p "$REPO_BASE/.azure"
if [ ! -L .azure ] && [ ! -d .azure ]; then
  ln -sfn "$REPO_BASE/.azure" .azure
elif [ -L .azure ]; then
  # Update symlink target if needed
  ln -sfn "$REPO_BASE/.azure" .azure
fi

# Run azd provision (interactive — prompts for subscription, location, env name)
azd provision

echo ""
echo "✅ Provisioning complete."
echo "   azd environment stored at: $REPO_BASE/.azure/"
echo ""
echo "Next steps:"
echo "   Run 'pnpm shared-infra:use' in any worktree to activate CosmosDB."
