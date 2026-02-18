#!/bin/bash
set -e

# Build all images using Azure Container Registry Build
# Usage: ./build-acr.sh [image-name...]
# Examples:
#   ./build-acr.sh                              # Build all images
#   ./build-acr.sh api                          # Build only api image
#   ./build-acr.sh api judge                    # Build api and judge in parallel
#   ./build-acr.sh coder-acp-copilot judge      # Build specific images in parallel

# Get ACR name from environment variable
if [ -z "$ACR_NAME" ]; then
  echo "Error: ACR_NAME environment variable is required"
  echo ""
  echo "Set it with:   export ACR_NAME=<your-acr-name>"
  echo "Or inline:     ACR_NAME=myacr $0"
  echo ""
  echo "Usage: $0 [image-name...]"
  echo ""
  echo "Arguments:"
  echo "  image-name  Optional: api, coder-acp-claude-code, coder-acp-copilot, judge, portal, or all (default)"
  exit 1
fi

IMAGE_ARGS=("${@:-all}")

echo "Using ACR: ${ACR_NAME}"

# Image list
ALL_IMAGES="api coder-acp-claude-code coder-acp-copilot judge portal"

get_dockerfile() {
  local name=$1
  case "$name" in
    api|judge|portal) echo "apps/${name}/Dockerfile" ;;
    coder-acp-*) echo "apps/workers/${name}/Dockerfile" ;;
    *) echo "apps/${name}/Dockerfile" ;;
  esac
}

build_image() {
  local name=$1
  local dockerfile=$(get_dockerfile "$name")
  local full_image="scoped/${name}:latest"
  local git_commit=$(git rev-parse --short HEAD)
  local build_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  az acr build \
    --registry "$ACR_NAME" \
    --image "$full_image" \
    --build-arg GIT_COMMIT="$git_commit" \
    --build-arg BUILD_TIME="$build_time" \
    --file "$dockerfile" \
    .
}

validate_image() {
  local target=$1
  for name in $ALL_IMAGES; do
    if [ "$name" = "$target" ]; then
      return 0
    fi
  done
  echo "Error: Unknown image '$target'"
  echo "Valid images: $ALL_IMAGES"
  exit 1
}

cd "$(dirname "$0")"
SCRIPT_DIR="$(pwd)"

# Expand "all" to the full image list
BUILD_LIST=()
for arg in "${IMAGE_ARGS[@]}"; do
  if [ "$arg" = "all" ]; then
    for name in $ALL_IMAGES; do
      BUILD_LIST+=("$name")
    done
  else
    validate_image "$arg"
    BUILD_LIST+=("$arg")
  fi
done

if [ ${#BUILD_LIST[@]} -eq 1 ]; then
  # Single image: build directly
  build_image "${BUILD_LIST[0]}"
else
  # Multiple images: build in parallel
  echo "Building ${#BUILD_LIST[@]} images in parallel to ACR: ${ACR_NAME}"
  cmds=()
  names=()
  for name in "${BUILD_LIST[@]}"; do
    cmds+=("ACR_NAME=$ACR_NAME $SCRIPT_DIR/build-acr.sh $name")
    names+=("$name")
  done

  names_joined=$(IFS=","; echo "${names[*]}")
  npx concurrently \
    --names "$names_joined" \
    --prefix-colors "blue,green,magenta,cyan,yellow" \
    "${cmds[@]}"
fi

echo ""
echo "Images available at:"
for name in "${BUILD_LIST[@]}"; do
  echo "  ${ACR_NAME}.azurecr.io/scoped/${name}:latest"
done