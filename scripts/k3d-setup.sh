#!/usr/bin/env bash
# =============================================================================
# k3d-setup.sh — Bootstrap a k3d cluster for Scoped local development
# =============================================================================
# Creates a k3d cluster and installs KEDA for queue-based autoscaling.
# Idempotent — safe to run multiple times.
#
# Prerequisites:
#   brew install k3d kubectl helm
#
# Usage:
#   ./scripts/k3d-setup.sh                    # default cluster name
#   ./scripts/k3d-setup.sh my-cluster         # custom cluster name
# =============================================================================
set -euo pipefail

CLUSTER_NAME="${1:-scoped}"
KEDA_VERSION="2.16.1"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------
for cmd in k3d kubectl helm; do
    command -v "$cmd" >/dev/null 2>&1 || error "$cmd is required but not found. Install it with: brew install $cmd"
done

# ---------------------------------------------------------------------------
# Create k3d cluster (if not exists)
# ---------------------------------------------------------------------------
if k3d cluster list 2>/dev/null | grep -q "^$CLUSTER_NAME "; then
    info "Cluster '$CLUSTER_NAME' already exists, skipping creation."
else
    info "Creating k3d cluster '$CLUSTER_NAME'..."
    k3d cluster create "$CLUSTER_NAME" \
        --agents 1 \
        --k3s-arg "--disable=traefik@server:0" \
        --wait
fi

# Ensure kubeconfig points to the cluster
info "Setting kubectl context to k3d-$CLUSTER_NAME..."
kubectl config use-context "k3d-$CLUSTER_NAME"

# ---------------------------------------------------------------------------
# Create the scoped namespace
# ---------------------------------------------------------------------------
if kubectl get namespace scoped >/dev/null 2>&1; then
    info "Namespace 'scoped' already exists."
else
    info "Creating namespace 'scoped'..."
    kubectl create namespace scoped
fi

# ---------------------------------------------------------------------------
# Install KEDA (if not already installed)
# ---------------------------------------------------------------------------
if helm list -n keda 2>/dev/null | grep -q "^keda "; then
    info "KEDA already installed, skipping."
else
    info "Installing KEDA v$KEDA_VERSION..."
    helm repo add kedacore https://kedacore.github.io/charts 2>/dev/null || true
    helm repo update kedacore
    helm install keda kedacore/keda \
        --namespace keda \
        --create-namespace \
        --version "$KEDA_VERSION" \
        --wait
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
info ""
info "k3d cluster '$CLUSTER_NAME' is ready!"
info ""
info "Next steps:"
info "  1. Generate worktree-env ports:  worktree-env"
info "  2. Start Tilt:                   tilt up"
info "  3. Open Tilt UI:                 http://localhost:10350"
info ""
info "Worker profiles (pass as tilt args):"
info "  tilt up -- --copilot                  # Copilot worker"
info "  tilt up -- --claude-code              # Claude Code worker"
info "  tilt up -- --electron                 # VS Code Electron worker"
info "  tilt up -- --all-workers              # All workers"
