#!/usr/bin/env bash
# =============================================================================
# k3d-down.sh — Tear down the local k3d cluster
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Read port offset
PORT_OFFSET=0
if [ -f ".port-offset" ]; then
  PORT_OFFSET=$(cat .port-offset | tr -d '[:space:]')
fi

CLUSTER_NAME="scope-${PORT_OFFSET:-0}"
REGISTRY_NAME="scope-${PORT_OFFSET:-0}-registry.localhost"

if ! k3d cluster list 2>/dev/null | grep -q "^$CLUSTER_NAME "; then
  echo "Cluster '$CLUSTER_NAME' does not exist."
  exit 0
fi

echo ">>> Deleting k3d cluster '$CLUSTER_NAME'..."
k3d cluster delete "$CLUSTER_NAME"

# Clean up the per-offset registry container
if k3d registry list 2>/dev/null | grep -q "$REGISTRY_NAME"; then
  echo ">>> Deleting registry '$REGISTRY_NAME'..."
  k3d registry delete "$REGISTRY_NAME"
fi

echo ">>> Cluster '$CLUSTER_NAME' deleted."
