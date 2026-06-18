#!/usr/bin/env bash
# =============================================================================
# k3d-build.sh — Build and push Docker images to local k3d registry
# =============================================================================
# Usage:
#   ./scripts/k3d-build.sh              # Build all services
#   ./scripts/k3d-build.sh api          # Build only the api
#   ./scripts/k3d-build.sh api portal   # Build api and portal
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Read port offset for registry port
PORT_OFFSET=0
if [ -f ".port-offset" ]; then
  PORT_OFFSET=$(cat .port-offset | tr -d '[:space:]')
fi

REGISTRY_PORT=$((5050 + PORT_OFFSET))
REGISTRY="scope-${PORT_OFFSET}-registry.localhost:${REGISTRY_PORT}"

# Ensure pushes to the local registry bypass any Docker/corporate proxy
export NO_PROXY="${NO_PROXY:+${NO_PROXY},}scope-${PORT_OFFSET}-registry.localhost,localhost,127.0.0.1"
export no_proxy="$NO_PROXY"

# Services available for local build (subset relevant for local dev)
ALL_SERVICES="api judge portal token-manager scheduler gateway coder-acp-copilot coder-acp-claude-code"

get_dockerfile() {
  local name=$1
  case "$name" in
    api|judge|portal) echo "apps/${name}/Dockerfile" ;;
    token-manager|scheduler) echo "apps/${name}/Dockerfile" ;;
    gateway) echo "apps/gateway/Dockerfile" ;;
    coder-acp-*) echo "apps/workers/${name}/Dockerfile" ;;
    *) echo "apps/${name}/Dockerfile" ;;
  esac
}

get_build_context() {
  local name=$1
  case "$name" in
    gateway) echo "apps/gateway" ;;
    *) echo "." ;;
  esac
}

get_target() {
  local name=$1
  case "$name" in
    gateway) echo "runtime" ;;
    *) echo "prod" ;;
  esac
}

build_and_push() {
  local name=$1
  local dockerfile=$(get_dockerfile "$name")
  local context=$(get_build_context "$name")
  local target=$(get_target "$name")
  local image="${REGISTRY}/scoped/${name}:latest"

  if [ ! -f "$dockerfile" ]; then
    echo "Warning: Dockerfile not found at $dockerfile, skipping $name"
    return 0
  fi

  # Source pinned versions if available (e.g. versions.env)
  local build_args=""
  local versions_file
  for versions_file in "apps/workers/${name}/versions.env" "apps/${name}/versions.env"; do
    if [ -f "$versions_file" ]; then
      local key value
      while IFS='=' read -r key value; do
        [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
        build_args="${build_args} --build-arg ${key}=${value}"
      done < "$versions_file"
      break
    fi
  done

  # --file is relative to repo root; context may differ per service
  local abs_dockerfile="$REPO_ROOT/$dockerfile"

  echo "  Building $name..."
  docker build \
    --file "$abs_dockerfile" \
    --tag "$image" \
    --target "$target" \
    ${build_args} \
    --quiet \
    "$context" 2>/dev/null || \
  docker build \
    --file "$abs_dockerfile" \
    --tag "$image" \
    ${build_args} \
    --quiet \
    "$context"

  echo "  Pushing $name..."
  docker push "$image" --quiet
}

# Determine what to build
if [ $# -eq 0 ]; then
  BUILD_LIST=($ALL_SERVICES)
else
  BUILD_LIST=("$@")
  # Validate
  for svc in "${BUILD_LIST[@]}"; do
    valid=false
    for known in $ALL_SERVICES; do
      if [ "$svc" = "$known" ]; then
        valid=true
        break
      fi
    done
    if [ "$valid" = "false" ]; then
      echo "Error: Unknown service '$svc'"
      echo "Available services: $ALL_SERVICES"
      exit 1
    fi
  done
fi

echo ">>> Building images → $REGISTRY"
echo "    Services: ${BUILD_LIST[*]}"
echo ""

for svc in "${BUILD_LIST[@]}"; do
  build_and_push "$svc"
done

echo ""
echo ">>> All images pushed to $REGISTRY"
