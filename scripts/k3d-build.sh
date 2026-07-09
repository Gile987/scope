#!/usr/bin/env bash
# =============================================================================
# k3d-build.sh — Build and push Docker images to local k3d registry
# =============================================================================
# Usage:
#   ./scripts/k3d-build.sh              # Build all services in parallel
#   ./scripts/k3d-build.sh api          # Build only the api
#   ./scripts/k3d-build.sh api portal   # Build api and portal
#   ./scripts/k3d-build.sh --no-cache   # Full rebuild without cache
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Read port offset for registry port (env var takes precedence over file)
if [ -z "${PORT_OFFSET:-}" ]; then
  PORT_OFFSET=0
  if [ -f ".port-offset" ]; then
    PORT_OFFSET=$(cat .port-offset | tr -d '[:space:]')
  fi
fi

REGISTRY_PORT=$((5050 + PORT_OFFSET))
REGISTRY="scope-${PORT_OFFSET}-registry.localhost:${REGISTRY_PORT}"

# Ensure pushes to the local registry bypass any Docker/corporate proxy
export NO_PROXY="${NO_PROXY:+${NO_PROXY},}scope-${PORT_OFFSET}-registry.localhost,localhost,127.0.0.1"
export no_proxy="$NO_PROXY"

# Parse flags
NO_CACHE=""
BUILD_TARGETS=""
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE="--no-cache" ;;
    *) BUILD_TARGETS="${BUILD_TARGETS:+$BUILD_TARGETS }$arg" ;;
  esac
done

# All known services (must match targets in docker-bake.hcl)
ALL_SERVICES="api judge portal token-manager scheduler gateway coder-acp-copilot coder-acp-claude-code"

# Validate requested targets
for svc in $BUILD_TARGETS; do
  valid=false
  for known in $ALL_SERVICES; do
    if [ "$svc" = "$known" ]; then valid=true; break; fi
  done
  if [ "$valid" = "false" ]; then
    echo "Error: Unknown service '$svc'"
    echo "Available services: $ALL_SERVICES"
    exit 1
  fi
done

echo ">>> Building images → $REGISTRY"

# ── Source worker version files as env vars for docker-bake.hcl ───────────
for versions_file in apps/workers/*/versions.env apps/*/versions.env; do
  if [ -f "$versions_file" ]; then
    set -a
    source "$versions_file"
    set +a
  fi
done

# ── Try parallel build with docker buildx bake ────────────────────────────
# Uses the default "docker" driver so builds share the host network and can
# push to the local k3d HTTP registry without insecure-registry workarounds.
if docker buildx bake --help &>/dev/null; then
  # Use default builder (docker driver) — it shares host network so it can
  # resolve the k3d registry on localhost. The docker-container driver runs
  # in its own container and cannot reach localhost registries.
  docker buildx use default 2>/dev/null || true

  BAKE_ARGS=(--file docker-bake.hcl --load)

  if [ -n "$NO_CACHE" ]; then
    BAKE_ARGS+=(--no-cache)
  fi

  if [ -z "$BUILD_TARGETS" ]; then
    echo "    Services: ALL (parallel)"
    REGISTRY="$REGISTRY" docker buildx bake "${BAKE_ARGS[@]}"
    PUSH_LIST="$ALL_SERVICES"
  else
    echo "    Services: $BUILD_TARGETS (parallel)"
    REGISTRY="$REGISTRY" docker buildx bake "${BAKE_ARGS[@]}" $BUILD_TARGETS
    PUSH_LIST="$BUILD_TARGETS"
  fi

  # Push images to local registry
  echo ""
  echo ">>> Pushing images to $REGISTRY..."
  push_failed=0
  for svc in $PUSH_LIST; do
    pushed=false
    for attempt in 1 2 3; do
      if docker push "${REGISTRY}/scoped/${svc}:latest" --quiet 2>/dev/null; then
        pushed=true
        break
      fi
      echo "  Retry $attempt/3 for $svc..."
      sleep 3
    done
    if [ "$pushed" = "false" ]; then
      echo "  ⚠ Failed to push $svc after 3 attempts"
      push_failed=1
    fi
  done
  if [ "$push_failed" -eq 0 ]; then
    echo "  ✓ All images pushed"
  else
    echo "  ⚠ Some pushes failed — check registry with: curl http://$REGISTRY/v2/_catalog"
    exit 1
  fi

  exit 0
fi

# ── Fallback: sequential docker build + push ──────────────────────────────
echo "  ⚠ docker buildx bake unavailable — falling back to sequential builds"
echo "    Install BuildKit for faster parallel builds."
echo ""

get_dockerfile() {
  local name=$1
  case "$name" in
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
    *) echo "" ;;
  esac
}

build_and_push() {
  local name=$1
  local dockerfile=$(get_dockerfile "$name")
  local context=$(get_build_context "$name")
  local target=$(get_target "$name")
  local image="${REGISTRY}/scoped/${name}:latest"

  if [ ! -f "$dockerfile" ]; then
    echo "  Warning: Dockerfile not found at $dockerfile, skipping $name"
    return 0
  fi

  local target_arg=""
  if [ -n "$target" ]; then target_arg="--target $target"; fi

  echo "  Building $name..."
  if ! docker build --file "$dockerfile" --tag "$image" ${target_arg} ${NO_CACHE} --quiet "$context"; then
    echo "  ⚠ Build failed for $name — skipping"
    return 0
  fi

  echo "  Pushing $name..."
  docker push "$image" --quiet
}

if [ -z "$BUILD_TARGETS" ]; then
  BUILD_LIST="$ALL_SERVICES"
else
  BUILD_LIST="$BUILD_TARGETS"
fi

echo "    Services: $BUILD_LIST (sequential)"
echo ""

for svc in $BUILD_LIST; do
  build_and_push "$svc"
done

echo ""
echo ">>> All images pushed to $REGISTRY"
