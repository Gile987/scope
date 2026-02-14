#!/bin/bash
set -euo pipefail

# =============================================================================
# setup-github-ci.sh — Automate GitHub Actions CI/CD setup for scope-mt-app
#
# Creates a dedicated Azure MSI, configures OIDC federation for GitHub Actions,
# assigns AcrPush role on the ACR, and sets all required GitHub Actions variables.
#
# Prerequisites:
#   - Azure CLI (az) authenticated
#   - GitHub CLI (gh) authenticated with repo scope
#   - azd environment configured in scope-mt-infra
#
# Usage:
#   ./scripts/setup-github-ci.sh --infra-repo ../scope-mt-infra
#   ./scripts/setup-github-ci.sh --infra-repo ../scope-mt-infra --azd-env scope-mt-prd
#   ./scripts/setup-github-ci.sh --infra-repo ../scope-mt-infra --github-repo owner/repo
# =============================================================================

# --- Defaults ----------------------------------------------------------------
MSI_NAME="msi-scoped-app"
ISSUER="https://token.actions.githubusercontent.com"
AUDIENCES="api://AzureADTokenExchange"
INFRA_REPO_PATH=""
GITHUB_REPO=""
AZD_ENV=""

# --- Colors & helpers --------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}ℹ${NC}  $*"; }
success() { echo -e "${GREEN}✓${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✗${NC}  $*" >&2; }
fatal()   { error "$@"; exit 1; }
step()    { echo -e "\n${BOLD}── $* ──${NC}"; }

# --- Parse arguments ---------------------------------------------------------
usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --infra-repo PATH      Path to scope-mt-infra repo (required)
  --azd-env NAME         azd environment name (default: current azd env)
  --github-repo OWNER/REPO  GitHub repo (default: auto-detect via gh)
  --msi-name NAME        MSI name (default: msi-scoped-app)
  --dry-run              Show what would be done without making changes
  -h, --help             Show this help

Examples:
  $(basename "$0") --infra-repo ../scope-mt-infra
  $(basename "$0") --infra-repo ../scope-mt-infra --azd-env scope-mt-prd
  $(basename "$0") --infra-repo ../scope-mt-infra --github-repo cedricvidal/scope-mt-app
EOF
  exit 0
}

DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --infra-repo)   INFRA_REPO_PATH="$2"; shift 2 ;;
    --azd-env)      AZD_ENV="$2"; shift 2 ;;
    --github-repo)  GITHUB_REPO="$2"; shift 2 ;;
    --msi-name)     MSI_NAME="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=true; shift ;;
    -h|--help)      usage ;;
    *)              fatal "Unknown option: $1. Use --help for usage." ;;
  esac
done

# --- Validate prerequisites --------------------------------------------------
step "Checking prerequisites"

for cmd in az gh azd jq; do
  if ! command -v "$cmd" &>/dev/null; then
    fatal "'$cmd' is required but not found in PATH"
  fi
done
success "All required CLIs found (az, gh, azd, jq)"

if [[ -z "$INFRA_REPO_PATH" ]]; then
  fatal "--infra-repo is required. Use --help for usage."
fi

INFRA_REPO_PATH="$(cd "$INFRA_REPO_PATH" && pwd)"
if [[ ! -f "$INFRA_REPO_PATH/azure.yaml" ]]; then
  fatal "$INFRA_REPO_PATH does not look like the scope-mt-infra repo (no azure.yaml)"
fi
success "Infra repo: $INFRA_REPO_PATH"

# --- Auto-detect GitHub repo -------------------------------------------------
if [[ -z "$GITHUB_REPO" ]]; then
  GITHUB_REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null) || true
  if [[ -z "$GITHUB_REPO" ]]; then
    fatal "Could not auto-detect GitHub repo. Use --github-repo OWNER/REPO"
  fi
fi
info "GitHub repo: $GITHUB_REPO"
GITHUB_REPO_SLUG="${GITHUB_REPO//\//-}"

# --- Load azd environment values ---------------------------------------------
step "Loading azd environment values"

AZD_ENV_FLAG=""
if [[ -n "$AZD_ENV" ]]; then
  AZD_ENV_FLAG="--environment $AZD_ENV"
fi

# shellcheck disable=SC2086
AZD_VALUES=$(cd "$INFRA_REPO_PATH" && azd env get-values $AZD_ENV_FLAG 2>/dev/null) \
  || fatal "Failed to run 'azd env get-values' in $INFRA_REPO_PATH"

# Extract values (azd env get-values outputs KEY="VALUE" lines)
extract_azd_val() {
  local key="$1"
  echo "$AZD_VALUES" | grep "^${key}=" | head -1 | sed 's/^[^=]*="//' | sed 's/"$//'
}

AZURE_SUBSCRIPTION_ID=$(extract_azd_val "AZURE_SUBSCRIPTION_ID")
AZURE_TENANT_ID=$(extract_azd_val "AZURE_TENANT_ID")
AZURE_RESOURCE_GROUP=$(extract_azd_val "AZURE_RESOURCE_GROUP")
ACR_NAME=$(extract_azd_val "AZURE_CONTAINER_REGISTRY_NAME")
AZURE_LOCATION=$(extract_azd_val "AZURE_LOCATION")

# Validate all required values
missing=()
[[ -z "$AZURE_SUBSCRIPTION_ID" ]] && missing+=("AZURE_SUBSCRIPTION_ID")
[[ -z "$AZURE_TENANT_ID" ]]      && missing+=("AZURE_TENANT_ID")
[[ -z "$AZURE_RESOURCE_GROUP" ]]  && missing+=("AZURE_RESOURCE_GROUP")
[[ -z "$ACR_NAME" ]]              && missing+=("AZURE_CONTAINER_REGISTRY_NAME")

if [[ ${#missing[@]} -gt 0 ]]; then
  fatal "Missing azd env values: ${missing[*]}. Run 'azd up' in scope-mt-infra first."
fi

info "Subscription:   $AZURE_SUBSCRIPTION_ID"
info "Tenant:         $AZURE_TENANT_ID"
info "Resource Group: $AZURE_RESOURCE_GROUP"
info "ACR:            $ACR_NAME"
info "Location:       ${AZURE_LOCATION:-<not set>}"

# --- Set active subscription -------------------------------------------------
az account set --subscription "$AZURE_SUBSCRIPTION_ID" 2>/dev/null \
  || fatal "Failed to set subscription $AZURE_SUBSCRIPTION_ID"
success "Azure subscription set"

# --- Create or reuse MSI -----------------------------------------------------
step "Managed Identity: $MSI_NAME"

MSI_JSON=$(az identity show \
  --name "$MSI_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  -o json 2>/dev/null) || true

if [[ -n "$MSI_JSON" ]]; then
  success "MSI already exists"
else
  if $DRY_RUN; then
    info "[dry-run] Would create MSI $MSI_NAME in $AZURE_RESOURCE_GROUP"
    MSI_JSON='{"clientId":"<dry-run>","principalId":"<dry-run>"}'
  else
    info "Creating MSI..."
    MSI_JSON=$(az identity create \
      --name "$MSI_NAME" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      ${AZURE_LOCATION:+--location "$AZURE_LOCATION"} \
      -o json) \
      || fatal "Failed to create MSI"
    success "MSI created"
  fi
fi

MSI_CLIENT_ID=$(echo "$MSI_JSON" | jq -r '.clientId')
MSI_PRINCIPAL_ID=$(echo "$MSI_JSON" | jq -r '.principalId')
info "Client ID:    $MSI_CLIENT_ID"
info "Principal ID: $MSI_PRINCIPAL_ID"

# --- Federated credentials ---------------------------------------------------
step "OIDC Federated Credentials"

add_federated_credential() {
  local cred_name="$1"
  local subject="$2"

  # Check if already exists
  if az identity federated-credential show \
    --identity-name "$MSI_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$cred_name" \
    &>/dev/null; then
    success "$cred_name — already exists"
    return
  fi

  if $DRY_RUN; then
    info "[dry-run] Would create: $cred_name → $subject"
    return
  fi

  az identity federated-credential create \
    --identity-name "$MSI_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$cred_name" \
    --issuer "$ISSUER" \
    --subject "$subject" \
    --audiences "$AUDIENCES" \
    -o none \
    || fatal "Failed to create federated credential: $cred_name"
  success "$cred_name → $subject"
}

add_federated_credential \
  "${GITHUB_REPO_SLUG}-main" \
  "repo:${GITHUB_REPO}:ref:refs/heads/main"

add_federated_credential \
  "${GITHUB_REPO_SLUG}-dev" \
  "repo:${GITHUB_REPO}:ref:refs/heads/dev"

add_federated_credential \
  "${GITHUB_REPO_SLUG}-pull_request" \
  "repo:${GITHUB_REPO}:pull_request"

# --- AcrPush role assignment --------------------------------------------------
step "ACR Role Assignment (AcrPush)"

ACR_RESOURCE_ID="/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/${AZURE_RESOURCE_GROUP}/providers/Microsoft.ContainerRegistry/registries/${ACR_NAME}"

EXISTING_ROLE=$(az role assignment list \
  --assignee "$MSI_PRINCIPAL_ID" \
  --role "AcrPush" \
  --scope "$ACR_RESOURCE_ID" \
  -o json 2>/dev/null | jq 'length')

if [[ "$EXISTING_ROLE" -gt 0 ]]; then
  success "AcrPush role already assigned"
else
  if $DRY_RUN; then
    info "[dry-run] Would assign AcrPush on $ACR_NAME to $MSI_PRINCIPAL_ID"
  else
    info "Assigning AcrPush role..."
    az role assignment create \
      --assignee-object-id "$MSI_PRINCIPAL_ID" \
      --assignee-principal-type "ServicePrincipal" \
      --role "AcrPush" \
      --scope "$ACR_RESOURCE_ID" \
      -o none \
      || fatal "Failed to assign AcrPush role"
    success "AcrPush role assigned on $ACR_NAME"
  fi
fi

# --- GitHub Actions variables ------------------------------------------------
step "GitHub Actions Variables"

set_gh_variable() {
  local name="$1"
  local value="$2"

  if $DRY_RUN; then
    info "[dry-run] Would set $name = $value"
    return
  fi

  echo "$value" | gh variable set "$name" --repo "$GITHUB_REPO" \
    || fatal "Failed to set GitHub variable: $name"
  success "$name = $value"
}

set_gh_variable "AZURE_CLIENT_ID"       "$MSI_CLIENT_ID"
set_gh_variable "AZURE_TENANT_ID"       "$AZURE_TENANT_ID"
set_gh_variable "AZURE_SUBSCRIPTION_ID" "$AZURE_SUBSCRIPTION_ID"
set_gh_variable "ACR_NAME"              "$ACR_NAME"

# --- Summary ------------------------------------------------------------------
step "Setup Complete"

echo ""
echo -e "${BOLD}Resource Summary${NC}"
echo "  MSI:                $MSI_NAME (in $AZURE_RESOURCE_GROUP)"
echo "  MSI Client ID:      $MSI_CLIENT_ID"
echo "  ACR:                $ACR_NAME (AcrPush assigned)"
echo "  GitHub Repo:        $GITHUB_REPO"
echo ""
echo -e "${BOLD}Federated Credentials${NC}"
echo "  • ${GITHUB_REPO_SLUG}-main          → repo:${GITHUB_REPO}:ref:refs/heads/main"
echo "  • ${GITHUB_REPO_SLUG}-dev           → repo:${GITHUB_REPO}:ref:refs/heads/dev"
echo "  • ${GITHUB_REPO_SLUG}-pull_request  → repo:${GITHUB_REPO}:pull_request"
echo ""
echo -e "${BOLD}GitHub Actions Variables${NC}"
echo "  AZURE_CLIENT_ID       = $MSI_CLIENT_ID"
echo "  AZURE_TENANT_ID       = $AZURE_TENANT_ID"
echo "  AZURE_SUBSCRIPTION_ID = $AZURE_SUBSCRIPTION_ID"
echo "  ACR_NAME              = $ACR_NAME"
echo ""
echo -e "${BOLD}Next Steps${NC}"
echo "  1. Verify: gh variable list --repo $GITHUB_REPO"
echo "  2. Trigger: gh workflow run build-images.yml --repo $GITHUB_REPO"
echo ""
