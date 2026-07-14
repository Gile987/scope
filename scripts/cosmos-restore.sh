#!/usr/bin/env bash
# =============================================================================
# cosmos-restore.sh - Restore a Cosmos DB for MongoDB database from an archive
# =============================================================================
# Safe by default:
#   - DRY RUN unless --execute is given (nothing is written)
#   - restores into a NEW database (<database>-restore-<UTC>) so live
#     collections and their Cosmos shard keys are never touched
#
# Usage:
#   pnpm db:restore                                  # dry-run, latest int2 archive
#   pnpm db:restore -- --archive path/to.archive.gz  # dry-run a specific archive
#   pnpm db:restore -- --execute                     # restore into a NEW db
#   pnpm db:restore -- --execute --to-database scope-mt-recovered
#   pnpm db:restore -- --execute --in-place          # write back into the source db (no drop)
#   pnpm db:restore -- --execute --in-place --force-drop   # DANGER: drop+recreate collections
#   pnpm db:restore -- --env int --via-kubectl       # run inside the cluster VNet
#                                                    # (required: Cosmos is private-only)
#
# Prerequisites:
#   - Azure CLI logged in (az login) with access to the target account
#   - To reach the DB, one of:
#       * --via-kubectl: a kubectl context whose cluster VNet has the private
#         endpoint for the target account (Scope Cosmos is publicNetworkAccess
#         Disabled), OR
#       * a network already allowed to reach the account, plus 'mongorestore'
#         on PATH (brew install mongodb-database-tools) or Docker running
#         (falls back to the mongo:4.2 image)
#
# Cosmos caveats:
#   - Restoring into a NEW database relies on implicit collection creation. If
#     the account disallows it, pre-provision the target collections first.
#   - --force-drop deletes and recreates collections; a Cosmos collection's
#     shard key is defined via the control plane (deploy manifests) and can be
#     lost. Re-apply deploy/base/mongodb-collections/*.yaml afterwards if used.
# =============================================================================
set -euo pipefail

# --- Defaults -----------------------------------------------------------------
ENV_NAME="${SCOPE_ENV:-int2}"
ACCOUNT=""
RESOURCE_GROUP=""
DATABASE=""            # source db inside the archive (and default target)
TO_DATABASE=""         # target db; default computed below
ARCHIVE=""
SUBSCRIPTION=""
FORCE_DOCKER=0
VIA_KUBECTL=0
KUBE_CONTEXT=""
KUBE_NAMESPACE="default"
KUBE_POD=""
EXECUTE=0
IN_PLACE=0
FORCE_DROP=0
ASSUME_YES=0
OUT_DIR="${BACKUP_DIR:-}"
EXPECTED_SUBSCRIPTION_ID="f7de4384-8753-4910-95d7-650b9d23cb6f" # "Project Scope"
DOCKER_IMAGE="mongo:4.2"

err()  { echo "ERROR: $*" >&2; }
info() { echo "  $*"; }
# Print the header comment block (from line 2 until the first non-comment line).
usage() { awk 'NR>=2 && /^#/ {sub(/^# ?/, ""); print; next} NR>=2 {exit}' "$0"; exit "${1:-0}"; }

resolve_preset() {
  case "$ENV_NAME" in
    int2) : "${ACCOUNT:=db-scope-v2-int2}"; : "${RESOURCE_GROUP:=rg-scope-v2-int2}" ;;
    int)  : "${ACCOUNT:=db-scope-v2-int}";  : "${RESOURCE_GROUP:=rg-scope-v2-int}"  ;;
    prod) : "${ACCOUNT:=db-scope-v2-prd}";  : "${RESOURCE_GROUP:=rg-scope-v2-prd}"  ;;
    *)    err "unknown --env '$ENV_NAME' (expected int2 | int | prod)"; exit 2 ;;
  esac
  : "${DATABASE:=scope-mt}"
}

# --- Parse args ---------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)             ENV_NAME="$2"; shift 2 ;;
    --account)         ACCOUNT="$2"; shift 2 ;;
    --resource-group)  RESOURCE_GROUP="$2"; shift 2 ;;
    --database)        DATABASE="$2"; shift 2 ;;
    --to-database)     TO_DATABASE="$2"; shift 2 ;;
    --archive)         ARCHIVE="$2"; shift 2 ;;
    --subscription)    SUBSCRIPTION="$2"; shift 2 ;;
    --out)             OUT_DIR="$2"; shift 2 ;;
    --docker)          FORCE_DOCKER=1; shift ;;
    --via-kubectl)     VIA_KUBECTL=1; shift ;;
    --kube-context)    KUBE_CONTEXT="$2"; shift 2 ;;
    --namespace)       KUBE_NAMESPACE="$2"; shift 2 ;;
    --execute)         EXECUTE=1; shift ;;
    --in-place)        IN_PLACE=1; shift ;;
    --force-drop)      FORCE_DROP=1; shift ;;
    -y|--yes)          ASSUME_YES=1; shift ;;
    --)                shift ;;
    -h|--help)         usage 0 ;;
    *)                 err "unknown argument: $1"; usage 2 ;;
  esac
done

resolve_preset

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/.backups/cosmos}"

# Optional --context flag for kubectl calls, plus pod cleanup on exit.
KUBE_CTX_ARG=()
[[ -n "$KUBE_CONTEXT" ]] && KUBE_CTX_ARG=(--context "$KUBE_CONTEXT")
cleanup() {
  if [[ -n "$KUBE_POD" ]]; then
    kubectl "${KUBE_CTX_ARG[@]}" delete pod "$KUBE_POD" -n "$KUBE_NAMESPACE" \
      --wait=false >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# --- Resolve the archive (default: latest for this env) -----------------------
if [[ -z "$ARCHIVE" ]]; then
  ARCHIVE="$(ls -t "$OUT_DIR/$ACCOUNT/${DATABASE}"-*.archive.gz 2>/dev/null | head -1 || true)"
fi
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  err "no archive found. Pass --archive <file> or run 'pnpm db:dump' first."
  err "searched: $OUT_DIR/$ACCOUNT/${DATABASE}-*.archive.gz"
  exit 1
fi

# --- Target database ----------------------------------------------------------
TS="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ "$IN_PLACE" -eq 1 ]]; then
  TO_DATABASE="$DATABASE"
else
  : "${TO_DATABASE:=${DATABASE}-restore-${TS}}"
fi

# --- Preflight: Azure ---------------------------------------------------------
command -v az >/dev/null 2>&1 || { err "azure CLI (az) not found on PATH."; exit 1; }
if [[ -n "$SUBSCRIPTION" ]]; then
  az account set --subscription "$SUBSCRIPTION" >/dev/null 2>&1 \
    || { err "could not set subscription '$SUBSCRIPTION'."; exit 1; }
fi
ACCOUNT_JSON="$(az account show -o json 2>/dev/null)" \
  || { err "not logged in to Azure. Run: az login"; exit 1; }
CUR_SUB_ID="$(printf '%s' "$ACCOUNT_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
CUR_SUB_NAME="$(printf '%s' "$ACCOUNT_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["name"])')"
if [[ "$CUR_SUB_ID" != "$EXPECTED_SUBSCRIPTION_ID" ]]; then
  echo "WARNING: active subscription is '$CUR_SUB_NAME' ($CUR_SUB_ID)," >&2
  echo "         expected 'Project Scope' ($EXPECTED_SUBSCRIPTION_ID). Continuing." >&2
fi

# --- Preflight: resolve the mongorestore runner -------------------------------
RUNNER=""
if [[ "$VIA_KUBECTL" -eq 1 ]]; then
  command -v kubectl >/dev/null 2>&1 || { err "--via-kubectl set but kubectl not found on PATH."; exit 1; }
  kubectl "${KUBE_CTX_ARG[@]}" get ns "$KUBE_NAMESPACE" >/dev/null 2>&1 \
    || { err "cannot reach namespace '$KUBE_NAMESPACE' (context: ${KUBE_CONTEXT:-current})."; exit 1; }
  RUNNER="kubectl"
elif [[ "$FORCE_DOCKER" -eq 0 ]] && command -v mongorestore >/dev/null 2>&1; then
  RUNNER="native"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  RUNNER="docker"
else
  err "no mongorestore available."
  err "install native tools:  brew install mongodb-database-tools"
  err "or start Docker so the ${DOCKER_IMAGE} fallback can run,"
  err "or use --via-kubectl to run inside the cluster (needed for private-only Cosmos)."
  exit 1
fi

# --- Integrity check against the manifest (if present) ------------------------
if [[ -f "$ARCHIVE.manifest.json" ]]; then
  WANT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("archiveSha256",""))' "$ARCHIVE.manifest.json" 2>/dev/null || true)"
  GOT="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  if [[ -n "$WANT" && "$WANT" != "$GOT" ]]; then
    err "archive sha256 does not match its manifest. Refusing to proceed."
    err "  manifest: $WANT"
    err "  archive:  $GOT"
    exit 1
  fi
fi

# --- Summarize the plan -------------------------------------------------------
MODE="DRY RUN (no writes)"
[[ "$EXECUTE" -eq 1 ]] && MODE="EXECUTE (writes data)"
DROP_DESC="no (documents are upserted by _id)"
[[ "$FORCE_DROP" -eq 1 ]] && DROP_DESC="YES - collections dropped then recreated"

echo "=== Cosmos DB restore ==="
info "Mode:           $MODE"
info "Account:        $ACCOUNT (rg: $RESOURCE_GROUP)"
info "Archive:        $ARCHIVE"
info "Source db:      $DATABASE"
info "Target db:      $TO_DATABASE$([[ "$IN_PLACE" -eq 1 ]] && echo "  (in-place)" || echo "  (new database)")"
info "Drop first:     $DROP_DESC"
info "Runner:         $RUNNER"
echo ""

# --- Guardrails ---------------------------------------------------------------
if [[ "$FORCE_DROP" -eq 1 && "$IN_PLACE" -ne 1 ]]; then
  err "--force-drop only makes sense with --in-place. Aborting."
  exit 2
fi

confirm() {
  local prompt="$1"
  [[ "$ASSUME_YES" -eq 1 ]] && return 0
  read -r -p "$prompt " reply
  [[ "$reply" == "yes" ]]
}

if [[ "$EXECUTE" -eq 1 ]]; then
  if [[ "$IN_PLACE" -eq 1 ]]; then
    echo "!! This will WRITE into the LIVE database '$DATABASE' on '$ACCOUNT'." >&2
    if [[ "$FORCE_DROP" -eq 1 ]]; then
      echo "!! --force-drop will DROP each collection first. Cosmos shard-key" >&2
      echo "!! definitions may be lost; re-apply deploy manifests afterwards." >&2
    fi
    confirm "Type 'yes' to proceed:" || { err "aborted."; exit 1; }
  else
    echo "This will create and populate a NEW database '$TO_DATABASE' on '$ACCOUNT'." >&2
    confirm "Type 'yes' to proceed:" || { err "aborted."; exit 1; }
  fi
fi

# --- Connection string (never echoed) -----------------------------------------
URI="$(az cosmosdb keys list -n "$ACCOUNT" -g "$RESOURCE_GROUP" \
        --type connection-strings \
        --query "connectionStrings[0].connectionString" -o tsv 2>/dev/null)" || true
[[ -n "${URI:-}" ]] || { err "could not read a connection string for '$ACCOUNT'."; exit 1; }

# --- Build mongorestore args --------------------------------------------------
RARGS=( --gzip --numParallelCollections=1 --numInsertionWorkersPerCollection=1
        --nsInclude="${DATABASE}.*" --nsFrom="${DATABASE}.*" --nsTo="${TO_DATABASE}.*" )
[[ "$EXECUTE" -eq 1 ]] || RARGS+=( --dryRun )
[[ "$FORCE_DROP" -eq 1 ]] && RARGS+=( --drop )

RLOG="$ARCHIVE.restore-${TS}.log"

# Start an ephemeral in-cluster pod with the mongo tools + VNet access.
kube_pod_up() {
  KUBE_POD="cosmos-restore-$(date -u +%s)-${RANDOM}"
  info "Starting in-cluster pod $KUBE_POD (ns:$KUBE_NAMESPACE, image:$DOCKER_IMAGE)..."
  kubectl "${KUBE_CTX_ARG[@]}" run "$KUBE_POD" -n "$KUBE_NAMESPACE" \
    --image="$DOCKER_IMAGE" --restart=Never --command -- sleep 3600 >/dev/null \
    || { err "failed to start in-cluster pod."; exit 1; }
  kubectl "${KUBE_CTX_ARG[@]}" wait --for=condition=Ready "pod/$KUBE_POD" \
    -n "$KUBE_NAMESPACE" --timeout=180s >/dev/null \
    || { err "in-cluster pod did not become ready."; exit 1; }
}

run_restore() {
  if [[ "$RUNNER" == kubectl ]]; then
    # Copy the archive in, then run mongorestore reading that file. The URI is
    # fed via stdin -> read (never on argv); RARGS are passed as positional
    # argv ("$@") so the pod shell never glob-expands the '*' in the namespaces.
    kubectl "${KUBE_CTX_ARG[@]}" cp "$ARCHIVE" "$KUBE_NAMESPACE/$KUBE_POD:/tmp/restore.gz" >/dev/null \
      || { err "failed to copy archive into the pod."; return 1; }
    printf '%s\n' "$URI" | kubectl "${KUBE_CTX_ARG[@]}" exec -i "$KUBE_POD" -n "$KUBE_NAMESPACE" -- \
      sh -c 'read MURI; exec mongorestore --uri "$MURI" --archive=/tmp/restore.gz "$@"' \
      _ "${RARGS[@]}" 2>&1 | tee "$RLOG"
    return "${PIPESTATUS[1]}"
  elif [[ "$RUNNER" == docker ]]; then
    local dir base
    dir="$(dirname "$ARCHIVE")"; base="$(basename "$ARCHIVE")"
    docker run --rm -e MURI="$URI" -v "$dir":/dump "$DOCKER_IMAGE" \
      mongorestore --uri "$MURI" --archive="/dump/$base" "${RARGS[@]}" 2>&1 | tee "$RLOG"
    return "${PIPESTATUS[0]}"
  else
    mongorestore --uri "$URI" --archive="$ARCHIVE" "${RARGS[@]}" 2>&1 | tee "$RLOG"
    return "${PIPESTATUS[0]}"
  fi
}

[[ "$RUNNER" == kubectl ]] && kube_pod_up

set +e
run_restore
RC=$?
set -e

echo ""
if [[ "$RC" -eq 0 ]]; then
  if [[ "$EXECUTE" -eq 1 ]]; then
    echo "=== RESTORE COMPLETE ==="
    info "Restored into: $TO_DATABASE on $ACCOUNT"
  else
    echo "=== DRY RUN OK (no data written) ==="
    info "Re-run with --execute to restore into '$TO_DATABASE'."
  fi
  info "Log: $RLOG"
else
  echo "=== RESTORE FAILED (exit $RC) ===" >&2
  info "Log: $RLOG"
fi
exit "$RC"
