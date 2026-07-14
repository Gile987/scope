#!/usr/bin/env bash
# =============================================================================
# cosmos-dump.sh - Snapshot a Cosmos DB for MongoDB database to a local archive
# =============================================================================
# Produces a portable, gzip-compressed mongodump archive plus a JSON manifest
# (per-collection counts, sha256, git SHA) and verifies the archive is readable.
# Intended as a rollback snapshot before a risky deploy / migration.
#
# Usage:
#   pnpm db:dump                       # default env: int2
#   pnpm db:dump -- --env int          # first int cluster
#   pnpm db:dump -- --env prod         # production
#   pnpm db:dump -- --account db-x --resource-group rg-x --database scope-mt
#   pnpm db:dump -- --out ~/cosmos-backups   # custom output dir
#   pnpm db:dump -- --docker           # force the Docker mongo:4.2 runner
#   pnpm db:dump -- --env int --via-kubectl  # run inside the cluster VNet
#                                            # (required: Cosmos is private-only)
#   pnpm db:dump -- --env int --via-kubectl --namespace scoped \
#                  --kube-context aks-scope-v2-int
#
# Prerequisites:
#   - Azure CLI logged in (az login) with access to the target account
#   - To reach the DB, one of:
#       * --via-kubectl: kubectl context whose cluster VNet has the private
#         endpoint for the target account (Scope Cosmos is publicNetworkAccess
#         Disabled, so a laptop mongodump cannot connect directly), OR
#       * a network already allowed to reach the account, plus 'mongodump' on
#         PATH (brew install mongodb-database-tools) or Docker running (the
#         script falls back to the mongo:4.2 image)
#
# Output (never committed - see .gitignore):
#   <out>/<account>/<database>-<UTC>.archive.gz         the dump
#   <out>/<account>/<database>-<UTC>.archive.gz.manifest.json
#   <out>/<account>/<database>-<UTC>.archive.gz.log      dump log
# =============================================================================
set -euo pipefail

# --- Defaults -----------------------------------------------------------------
ENV_NAME="${SCOPE_ENV:-int2}"
ACCOUNT=""
RESOURCE_GROUP=""
DATABASE=""
SUBSCRIPTION=""
FORCE_DOCKER=0
VIA_KUBECTL=0
KUBE_CONTEXT=""
KUBE_NAMESPACE="default"
OUT_DIR="${BACKUP_DIR:-}"
EXPECTED_SUBSCRIPTION_ID="f7de4384-8753-4910-95d7-650b9d23cb6f" # "Project Scope"
DOCKER_IMAGE="mongo:4.2"
MAX_RETRIES=3
KUBE_POD=""

# --- Helpers ------------------------------------------------------------------
err()  { echo "ERROR: $*" >&2; }
info() { echo "  $*"; }

# Print the header comment block (lines from 2 until the first non-comment line).
usage() {
  awk 'NR>=2 && /^#/ {sub(/^# ?/, ""); print; next} NR>=2 {exit}' "$0"
  exit "${1:-0}"
}

# Map an --env preset to account / resource-group / database.
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
    --subscription)    SUBSCRIPTION="$2"; shift 2 ;;
    --out)             OUT_DIR="$2"; shift 2 ;;
    --docker)          FORCE_DOCKER=1; shift ;;
    --via-kubectl)     VIA_KUBECTL=1; shift ;;
    --kube-context)    KUBE_CONTEXT="$2"; shift 2 ;;
    --namespace)       KUBE_NAMESPACE="$2"; shift 2 ;;
    --)                shift ;;
    -h|--help)         usage 0 ;;
    *)                 err "unknown argument: $1"; usage 2 ;;
  esac
done

resolve_preset

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/.backups/cosmos}"

# Optional --context flag for kubectl calls.
KUBE_CTX_ARG=()
[[ -n "$KUBE_CONTEXT" ]] && KUBE_CTX_ARG=(--context "$KUBE_CONTEXT")

# Cleanup: temp files + any ephemeral in-cluster pod.
EXPECTED_FILE=""
cleanup() {
  [[ -n "$EXPECTED_FILE" ]] && rm -f "$EXPECTED_FILE" 2>/dev/null || true
  if [[ -n "$KUBE_POD" ]]; then
    kubectl "${KUBE_CTX_ARG[@]}" delete pod "$KUBE_POD" -n "$KUBE_NAMESPACE" \
      --wait=false >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

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

# --- Preflight: resolve the mongodump runner ----------------------------------
# RUNNER = native | docker | kubectl
RUNNER=""
if [[ "$VIA_KUBECTL" -eq 1 ]]; then
  command -v kubectl >/dev/null 2>&1 || { err "--via-kubectl set but kubectl not found on PATH."; exit 1; }
  kubectl "${KUBE_CTX_ARG[@]}" get ns "$KUBE_NAMESPACE" >/dev/null 2>&1 \
    || { err "cannot reach namespace '$KUBE_NAMESPACE' (context: ${KUBE_CONTEXT:-current}). Check kube-context/namespace."; exit 1; }
  RUNNER="kubectl"
elif [[ "$FORCE_DOCKER" -eq 0 ]] && command -v mongodump >/dev/null 2>&1; then
  RUNNER="native"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  RUNNER="docker"
else
  err "no mongodump available."
  err "install native tools:  brew install mongodb-database-tools"
  err "or start Docker so the ${DOCKER_IMAGE} fallback can run,"
  err "or use --via-kubectl to run inside the cluster (needed for private-only Cosmos)."
  exit 1
fi

if [[ "$RUNNER" == kubectl ]]; then
  RUNNER_DESC="kubectl (${KUBE_CONTEXT:-current-context}, ns:$KUBE_NAMESPACE, $DOCKER_IMAGE)"
elif [[ "$RUNNER" == native ]]; then
  RUNNER_DESC="native ($(mongodump --version | head -1))"
else
  RUNNER_DESC="docker ($DOCKER_IMAGE)"
fi

echo "=== Cosmos DB dump ==="
info "Env:            $ENV_NAME"
info "Account:        $ACCOUNT (rg: $RESOURCE_GROUP)"
info "Database:       $DATABASE"
info "Runner:         $RUNNER_DESC"
info "Output dir:     $OUT_DIR"
echo ""

# --- Fetch connection string (never echoed) -----------------------------------
URI="$(az cosmosdb keys list -n "$ACCOUNT" -g "$RESOURCE_GROUP" \
        --type connection-strings \
        --query "connectionStrings[0].connectionString" -o tsv 2>/dev/null)" || true
if [[ -z "${URI:-}" ]]; then
  err "could not read a connection string for account '$ACCOUNT' in '$RESOURCE_GROUP'."
  err "check the account/resource-group names and your permissions."
  exit 1
fi

# Inject the target database into the URI path so we do not need --db
# (mongo tools reject --uri together with --db). Done in-memory; never logged.
uri_with_db() {
  local base query
  if [[ "$URI" == *\?* ]]; then
    base="${URI%%\?*}"; query="${URI#*\?}"
  else
    base="$URI"; query=""
  fi
  [[ "$base" == */ ]] || base="$base/"
  if [[ -n "$query" ]]; then printf '%s%s?%s' "$base" "$DATABASE" "$query"
  else printf '%s%s' "$base" "$DATABASE"; fi
}
URI_DB="$(uri_with_db)"

# --- Baseline: collections Cosmos reports for this database -------------------
EXPECTED_FILE="$(mktemp)"
az cosmosdb mongodb collection list -a "$ACCOUNT" -g "$RESOURCE_GROUP" -d "$DATABASE" \
  --query "[].name" -o tsv 2>/dev/null | sort > "$EXPECTED_FILE" || true
EXPECTED_COUNT="$(wc -l < "$EXPECTED_FILE" | tr -d ' ')"
info "Collections reported by Cosmos: $EXPECTED_COUNT"

# --- Paths --------------------------------------------------------------------
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$OUT_DIR/$ACCOUNT"
mkdir -p "$DEST"
ARCHIVE="$DEST/${DATABASE}-${TS}.archive.gz"
ARCHIVE_BASE="$(basename "$ARCHIVE")"
LOG="$ARCHIVE.log"
MANIFEST="$ARCHIVE.manifest.json"

# --- Dump (with retries for RU throttling) ------------------------------------
# Start an ephemeral in-cluster pod that has the mongo tools and VNet access.
kube_pod_up() {
  KUBE_POD="cosmos-dump-$(date -u +%s)-${RANDOM}"
  info "Starting in-cluster pod $KUBE_POD (ns:$KUBE_NAMESPACE, image:$DOCKER_IMAGE)..."
  kubectl "${KUBE_CTX_ARG[@]}" run "$KUBE_POD" -n "$KUBE_NAMESPACE" \
    --image="$DOCKER_IMAGE" --restart=Never --command -- sleep 3600 >/dev/null \
    || { err "failed to start in-cluster pod."; exit 1; }
  kubectl "${KUBE_CTX_ARG[@]}" wait --for=condition=Ready "pod/$KUBE_POD" \
    -n "$KUBE_NAMESPACE" --timeout=180s >/dev/null \
    || { err "in-cluster pod did not become ready."; exit 1; }
}

run_dump() {
  if [[ "$RUNNER" == kubectl ]]; then
    # URI via stdin -> read (never on argv); archive streamed to stdout, log to stderr.
    printf '%s\n' "$URI_DB" | kubectl "${KUBE_CTX_ARG[@]}" exec -i "$KUBE_POD" \
      -n "$KUBE_NAMESPACE" -- \
      sh -c 'read MURI; exec mongodump --uri "$MURI" --gzip --archive --numParallelCollections=1' \
      > "$ARCHIVE" 2> "$LOG"
    return "${PIPESTATUS[1]}"
  elif [[ "$RUNNER" == docker ]]; then
    docker run --rm -e MURI="$URI_DB" -e ARC="/dump/$ARCHIVE_BASE" \
      -v "$DEST":/dump "$DOCKER_IMAGE" \
      sh -c 'mongodump --uri "$MURI" --gzip --archive="$ARC" --numParallelCollections=1' 2>&1 | tee "$LOG"
    return "${PIPESTATUS[0]}"
  else
    mongodump --uri "$URI_DB" --gzip --archive="$ARCHIVE" --numParallelCollections=1 2>&1 | tee "$LOG"
    return "${PIPESTATUS[0]}"
  fi
}

[[ "$RUNNER" == kubectl ]] && kube_pod_up

echo ""
info "Dumping to $ARCHIVE ..."
attempt=1
while true; do
  set +e
  run_dump
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then break; fi
  if grep -qiE '16500|TooManyRequests|429|RequestRateTooLarge' "$LOG" 2>/dev/null; then
    err "mongodump hit RU throttling (429)."
  fi
  if [[ "$attempt" -ge "$MAX_RETRIES" ]]; then
    err "mongodump failed after $attempt attempt(s) (exit $rc). See $LOG"
    exit "$rc"
  fi
  backoff=$((attempt * 5))
  err "mongodump failed (exit $rc); retrying in ${backoff}s ($attempt/$MAX_RETRIES)..."
  sleep "$backoff"
  attempt=$((attempt + 1))
done

[[ -s "$ARCHIVE" ]] || { err "archive is missing or empty: $ARCHIVE"; exit 1; }

# --- Manifest + verification (parse dump log, compare to Cosmos baseline) -----
SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
case "$RUNNER" in
  kubectl) TOOL="kubectl:$DOCKER_IMAGE (ns:$KUBE_NAMESPACE)" ;;
  docker)  TOOL="docker:$DOCKER_IMAGE" ;;
  *)       TOOL="native:$(mongodump --version | head -1)" ;;
esac

set +e
MANIFEST="$MANIFEST" ARCHIVE_BASE="$ARCHIVE_BASE" ENV_NAME="$ENV_NAME" \
ACCOUNT="$ACCOUNT" RESOURCE_GROUP="$RESOURCE_GROUP" DATABASE="$DATABASE" \
TS="$TS" GIT_SHA="$GIT_SHA" SHA256="$SHA256" TOOL="$TOOL" \
LOG="$LOG" EXPECTED_FILE="$EXPECTED_FILE" \
python3 - <<'PY'
import json, os, re, sys

db        = os.environ["DATABASE"]
log_path  = os.environ["LOG"]
expected  = [l.strip() for l in open(os.environ["EXPECTED_FILE"]) if l.strip()]

counts = {}
rx = re.compile(r'done dumping ' + re.escape(db) + r'\.(?P<c>\S+) \((?P<n>\d+) document')
with open(log_path, errors="replace") as fh:
    for line in fh:
        m = rx.search(line)
        if m:
            counts[m.group("c")] = int(m.group("n"))

dumped = set(counts)
exp    = set(expected)
missing = sorted(exp - dumped)     # live collections that did NOT get dumped -> FAIL
extra   = sorted(dumped - exp)     # dumped but not in az listing -> informational

manifest = {
    "env": os.environ["ENV_NAME"],
    "account": os.environ["ACCOUNT"],
    "resourceGroup": os.environ["RESOURCE_GROUP"],
    "database": db,
    "utc": os.environ["TS"],
    "gitSha": os.environ["GIT_SHA"],
    "archive": os.environ["ARCHIVE_BASE"],
    "archiveSha256": os.environ["SHA256"],
    "tool": os.environ["TOOL"],
    "expectedCollections": sorted(expected),
    "dumpedCounts": dict(sorted(counts.items())),
    "totalDocuments": sum(counts.values()),
    "collectionsDumped": len(dumped),
    "missingCollections": missing,
}
with open(os.environ["MANIFEST"], "w") as fh:
    json.dump(manifest, fh, indent=2)

print(f"  Collections dumped: {len(dumped)}  documents: {sum(counts.values())}")
if extra:
    print(f"  Note: dumped but not in Cosmos listing: {', '.join(extra)}")
if missing:
    print(f"  FAIL: live collections missing from dump: {', '.join(missing)}", file=sys.stderr)
    sys.exit(1)
PY
VERIFY_RC=$?
set -e

# --- Structural read check: gzip integrity of the archive (offline) ----------
# A mongodump --gzip --archive stream is gzip-compressed; gzip -t validates it
# without needing a mongod/Cosmos connection (mongorestore --dryRun would try
# to connect to a server). The full restore path is exercised by cosmos-restore.sh.
if ! gzip -t "$ARCHIVE" 2>/dev/null; then
  err "verification failed: archive did not pass gzip integrity check ($ARCHIVE)"
  VERIFY_RC=1
fi

echo ""
if [[ "$VERIFY_RC" -eq 0 ]]; then
  echo "=== PASS ==="
else
  echo "=== VERIFY FAILED (see logs) ==="
fi
info "Archive:  $ARCHIVE"
info "Manifest: $MANIFEST"
info "SHA256:   $SHA256"
echo ""
info "To preview a restore from this archive:"
info "  pnpm db:restore -- --env $ENV_NAME --archive \"$ARCHIVE\""
exit "$VERIFY_RC"
