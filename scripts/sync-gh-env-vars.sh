#!/bin/bash
# ---------------------------------------------------------------------------
# Sync CI/CD variables to GitHub environment
#
# Sets GitHub Actions environment variables needed for the build workflow.
# Compares desired values with existing repo-level and env-level variables,
# only creating/updating variables that differ.
#
# Prerequisites:
#   - az CLI (logged in)
#   - gh CLI (authenticated with repo and environment access)
#
# Usage:
#   ./scripts/sync-gh-env-vars.sh <acr-name> <acr-resource-group> --env <name> [--dry-run] [-y]
#
# Options:
#   --env <name>   GitHub environment name (required)
#   --dry-run      Show what would be set without making changes
#   -y, --yes      Skip confirmation prompt
#
# Examples:
#   ./scripts/sync-gh-env-vars.sh acrscopemtint rg-scope-mt-int --env integration --dry-run
#   ./scripts/sync-gh-env-vars.sh acrscopemtint rg-scope-mt-int --env integration -y
# ---------------------------------------------------------------------------
set -euo pipefail

# --- Parse arguments -------------------------------------------------------
GH_ENV=""
DRY_RUN=false
SKIP_CONFIRM=false
POSITIONAL_ARGS=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --env)
      GH_ENV="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -y|--yes)
      SKIP_CONFIRM=true
      shift
      ;;
    *)
      POSITIONAL_ARGS+=("$1")
      shift
      ;;
  esac
done

set -- "${POSITIONAL_ARGS[@]}"

# --- Validate arguments ---------------------------------------------------
if [ $# -lt 2 ] || [ -z "$GH_ENV" ]; then
  echo "Usage: $0 <acr-name> <acr-resource-group> --env <name> [--dry-run] [-y]"
  echo ""
  echo "Options:"
  echo "  --env <name>   GitHub environment name (required)"
  echo "  --dry-run      Show what would be set without making changes"
  echo "  -y, --yes      Skip confirmation prompt"
  echo ""
  echo "Examples:"
  echo "  $0 acrscopemtint rg-scope-mt-int --env integration --dry-run"
  echo "  $0 acrscopemtprd rg-scope-mt-prd --env prod -y"
  exit 1
fi

ACR_NAME="$1"
ACR_RESOURCE_GROUP="$2"

echo "Syncing CI/CD variables → GitHub environment '$GH_ENV'"
if $DRY_RUN; then
  echo "(dry-run mode — no changes will be made)"
fi
echo ""

# --- Detect GitHub repo ---------------------------------------------------
echo "Detecting GitHub repository..."
GITHUB_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo "  Repository: $GITHUB_REPO"

# --- Get Azure context ----------------------------------------------------
echo "Reading Azure context..."
AZURE_SUBSCRIPTION_ID=$(az account show --query id -o tsv)
AZURE_TENANT_ID=$(az account show --query tenantId -o tsv)
echo "  Subscription: $AZURE_SUBSCRIPTION_ID"
echo "  Tenant: $AZURE_TENANT_ID"

# --- Get Client ID from existing identity ---------------------------------
IDENTITY_NAME="mi-cicd-$(echo "$GITHUB_REPO" | tr '/' '-')"
echo "Looking up identity '$IDENTITY_NAME'..."
AZURE_CLIENT_ID=$(az identity show \
  --name "$IDENTITY_NAME" \
  --resource-group "$ACR_RESOURCE_GROUP" \
  --query clientId -o tsv 2>/dev/null || true)

if [ -z "$AZURE_CLIENT_ID" ]; then
  echo "ERROR: Identity '$IDENTITY_NAME' not found in resource group '$ACR_RESOURCE_GROUP'."
  echo "       Run setup-cicd.sh first to create the identity."
  exit 1
fi
echo "  Client ID: $AZURE_CLIENT_ID"

# --- Fetch current GitHub variables ---------------------------------------
echo ""
echo "Fetching current GitHub variables..."

# Fetch repo-level variables
REPO_VAR_NAMES=()
REPO_VAR_VALUES=()
while IFS=$'\t' read -r name value; do
  REPO_VAR_NAMES+=("$name")
  REPO_VAR_VALUES+=("$value")
done < <(gh variable list --json name,value --jq '.[] | [.name, .value] | @tsv' 2>/dev/null || true)

echo "Repo-level variables (${#REPO_VAR_NAMES[@]}):"
if [ ${#REPO_VAR_NAMES[@]} -eq 0 ]; then
  echo "  (none)"
else
  for i in "${!REPO_VAR_NAMES[@]}"; do
    echo "  ${REPO_VAR_NAMES[$i]} = ${REPO_VAR_VALUES[$i]}"
  done
fi

# Fetch environment-level variables
ENV_VAR_NAMES=()
ENV_VAR_VALUES=()
while IFS=$'\t' read -r name value; do
  ENV_VAR_NAMES+=("$name")
  ENV_VAR_VALUES+=("$value")
done < <(gh variable list --env "$GH_ENV" --json name,value --jq '.[] | [.name, .value] | @tsv' 2>/dev/null || true)

echo ""
echo "Environment-level variables in '$GH_ENV' (${#ENV_VAR_NAMES[@]}):"
if [ ${#ENV_VAR_NAMES[@]} -eq 0 ]; then
  echo "  (none)"
else
  for i in "${!ENV_VAR_NAMES[@]}"; do
    echo "  ${ENV_VAR_NAMES[$i]} = ${ENV_VAR_VALUES[$i]}"
  done
fi

# --- Helper functions ------------------------------------------------------
get_env_var_value() {
  local search_name="$1"
  for i in "${!ENV_VAR_NAMES[@]}"; do
    if [[ "${ENV_VAR_NAMES[$i]}" == "$search_name" ]]; then
      echo "${ENV_VAR_VALUES[$i]}"
      return
    fi
  done
  echo ""
}

get_repo_var_value() {
  local search_name="$1"
  for i in "${!REPO_VAR_NAMES[@]}"; do
    if [[ "${REPO_VAR_NAMES[$i]}" == "$search_name" ]]; then
      echo "${REPO_VAR_VALUES[$i]}"
      return
    fi
  done
  echo ""
}

# --- Build desired state and compare --------------------------------------
echo ""
echo "=== Desired State ==="
echo ""

# Arrays for tracking changes
VARS_TO_CREATE=()
VARS_TO_UPDATE=()
VARS_UNCHANGED=()
VARS_OVERRIDE_REPO=()

# Helper to check and categorize a variable
check_var() {
  local name="$1"
  local new_value="$2"
  
  local env_value repo_value
  env_value=$(get_env_var_value "$name")
  repo_value=$(get_repo_var_value "$name")
  
  if [ -n "$env_value" ]; then
    # Variable exists at environment level
    if [[ "$env_value" == "$new_value" ]]; then
      VARS_UNCHANGED+=("$name (env)")
    else
      VARS_TO_UPDATE+=("$name|$env_value|$new_value")
    fi
  elif [ -n "$repo_value" ]; then
    # Variable exists only at repo level
    if [[ "$repo_value" == "$new_value" ]]; then
      VARS_UNCHANGED+=("$name (repo=same)")
    else
      VARS_OVERRIDE_REPO+=("$name|$repo_value|$new_value")
    fi
  else
    # Variable doesn't exist anywhere
    VARS_TO_CREATE+=("$name|$new_value")
  fi
}

# Check all variables
check_var "AZURE_CLIENT_ID" "$AZURE_CLIENT_ID"
check_var "AZURE_TENANT_ID" "$AZURE_TENANT_ID"
check_var "AZURE_SUBSCRIPTION_ID" "$AZURE_SUBSCRIPTION_ID"
check_var "ACR_NAME" "$ACR_NAME"
check_var "ACR_RESOURCE_GROUP" "$ACR_RESOURCE_GROUP"

# --- Display changes -------------------------------------------------------
echo "Changes to apply to GitHub environment '$GH_ENV':"
echo ""

if [ ${#VARS_TO_CREATE[@]} -gt 0 ]; then
  echo "  CREATE (${#VARS_TO_CREATE[@]}):"
  for entry in "${VARS_TO_CREATE[@]}"; do
    IFS='|' read -r name value <<< "$entry"
    echo "    + $name = $value"
  done
  echo ""
fi

if [ ${#VARS_TO_UPDATE[@]} -gt 0 ]; then
  echo "  UPDATE (${#VARS_TO_UPDATE[@]}):"
  for entry in "${VARS_TO_UPDATE[@]}"; do
    IFS='|' read -r name old_val new_val <<< "$entry"
    echo "    ~ $name"
    echo "        current: $old_val"
    echo "        new:     $new_val"
  done
  echo ""
fi

if [ ${#VARS_OVERRIDE_REPO[@]} -gt 0 ]; then
  echo "  CREATE to override repo-level (${#VARS_OVERRIDE_REPO[@]}):"
  for entry in "${VARS_OVERRIDE_REPO[@]}"; do
    IFS='|' read -r name repo_val new_val <<< "$entry"
    echo "    ^ $name"
    echo "        repo-level: $repo_val"
    echo "        env-level:  $new_val (will override)"
  done
  echo ""
fi

if [ ${#VARS_UNCHANGED[@]} -gt 0 ]; then
  echo "  UNCHANGED (${#VARS_UNCHANGED[@]}):"
  for name in "${VARS_UNCHANGED[@]}"; do
    echo "    = $name"
  done
  echo ""
fi

# --- Check if there are any changes ----------------------------------------
TOTAL_CHANGES=$((${#VARS_TO_CREATE[@]} + ${#VARS_TO_UPDATE[@]} + ${#VARS_OVERRIDE_REPO[@]}))

if [ $TOTAL_CHANGES -eq 0 ]; then
  echo "No changes needed — all variables are up to date."
  exit 0
fi

# --- Dry run exit ----------------------------------------------------------
if $DRY_RUN; then
  echo "(dry-run) No changes made."
  exit 0
fi

# --- Confirmation prompt ---------------------------------------------------
if ! $SKIP_CONFIRM; then
  read -p "Apply $TOTAL_CHANGES variable changes to environment '$GH_ENV'? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# --- Apply changes ---------------------------------------------------------
echo ""
echo "Ensuring GitHub environment '$GH_ENV' exists..."
gh api "repos/${GITHUB_REPO}/environments/${GH_ENV}" -X PUT -f wait_timer=0 --silent || true

echo "Setting variables..."

for entry in "${VARS_TO_CREATE[@]}"; do
  IFS='|' read -r name value <<< "$entry"
  echo "  Creating $name..."
  gh variable set "$name" --env "$GH_ENV" --body "$value"
done

for entry in "${VARS_TO_UPDATE[@]}"; do
  IFS='|' read -r name _ new_val <<< "$entry"
  echo "  Updating $name..."
  gh variable set "$name" --env "$GH_ENV" --body "$new_val"
done

for entry in "${VARS_OVERRIDE_REPO[@]}"; do
  IFS='|' read -r name _ new_val <<< "$entry"
  echo "  Creating $name (overriding repo-level)..."
  gh variable set "$name" --env "$GH_ENV" --body "$new_val"
done

echo ""
echo "=== Sync complete ==="
echo ""
echo "GitHub environment '$GH_ENV' variables are now configured."
echo "Jobs using 'environment: $GH_ENV' will use these variables."
