# =============================================================================
# docker-bake.hcl — Parallel image builds for k3d local development
# =============================================================================
# Usage:
#   docker buildx bake                          # Build all services in parallel
#   docker buildx bake api                      # Build a single service
#   docker buildx bake api portal judge         # Build specific services
#
# Override registry:
#   REGISTRY=my-registry:5050 docker buildx bake
# =============================================================================

variable "REGISTRY" {
  default = "scope-0-registry.localhost:5050"
}

group "default" {
  targets = [
    "api",
    "judge",
    "portal",
    "token-manager",
    "scheduler",
    "gateway",
    "coder-acp-copilot",
    "coder-acp-claude-code",
  ]
}

# --- Application services ---

target "api" {
  dockerfile = "apps/api/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/api:latest"]
  output     = ["type=registry,push=true"]
}

target "judge" {
  dockerfile = "apps/judge/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/judge:latest"]
  output     = ["type=registry,push=true"]
}

target "portal" {
  dockerfile = "apps/portal/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/portal:latest"]
  output     = ["type=registry,push=true"]
}

target "token-manager" {
  dockerfile = "apps/token-manager/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/token-manager:latest"]
  output     = ["type=registry,push=true"]
}

target "scheduler" {
  dockerfile = "apps/scheduler/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/scheduler:latest"]
  output     = ["type=registry,push=true"]
}

target "gateway" {
  dockerfile = "apps/gateway/Dockerfile"
  context    = "apps/gateway"
  target     = "runtime"
  tags       = ["${REGISTRY}/scoped/gateway:latest"]
  output     = ["type=registry,push=true"]
}

# --- Worker services ---

target "coder-acp-copilot" {
  dockerfile = "apps/workers/coder-acp-copilot/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/coder-acp-copilot:latest"]
  output     = ["type=registry,push=true"]
}

target "coder-acp-claude-code" {
  dockerfile = "apps/workers/coder-acp-claude-code/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/coder-acp-claude-code:latest"]
  output     = ["type=registry,push=true"]
}
