#!/bin/bash
set -e

# Build all images using Azure Container Registry Build
# Usage: ./build-acr.sh [image-name...]
# Examples:
#   ./build-acr.sh                              # Build all images
#   ./build-acr.sh api                          # Build only api image
#   ./build-acr.sh api judge                    # Build api and judge in parallel
#   ./build-acr.sh coder-acp-copilot judge      # Build specific images in parallel

# Get ACR name from azd environment or env var
if [ -z "$ACR_NAME" ]; then
  # Try to get from azd env (look in parent scope-mt-infra project)
  AZD_ENV_FILE="../scope-mt-infra/.azure"
  if [ -d "$AZD_ENV_FILE" ]; then
    ACR_NAME=$(cd ../scope-mt-infra && azd env get-values 2>/dev/null | grep AZURE_CONTAINER_REGISTRY_NAME | cut -d'"' -f2)
  fi
fi

IMAGE_ARGS=("${@:-all}")

if [ -z "$ACR_NAME" ]; then
  echo "Error: Could not determine ACR name"
  echo ""
  echo "Options:"
  echo "  1. Run from a directory with azd environment configured"
  echo "  2. Set ACR_NAME environment variable: ACR_NAME=myacr $0"
  echo ""
  echo "Usage: $0 [image-name...]"
  echo ""
  echo "Arguments:"
  echo "  image-name  Optional: api, coder-acp-claude-code, coder-acp-copilot, judge, or all (default)"
  exit 1
fi

echo "Using ACR: ${ACR_NAME}"

# Image list
ALL_IMAGES="api coder-acp-claude-code coder-acp-copilot judge"

get_dockerfile() {
  local name=$1
  echo "Dockerfile.${name}"
}

build_image() {
  local name=$1
  local dockerfile=$(get_dockerfile "$name")
  local full_image="scoped/${name}:latest"
  
  az acr build \
    --registry "$ACR_NAME" \
    --image "$full_image" \
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
  # concurrently prints "[name] exited with code X" for each process
  # and exits non-zero if any command fails
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