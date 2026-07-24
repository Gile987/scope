#!/usr/bin/env bash
#
# generate-notice.sh — (re)build the repository-root NOTICE file for the
# third-party open source software redistributed by Scope.
#
# This script ONLY orchestrates purpose-built license tooling and concatenates
# their output. It never authors, summarizes, or edits any license text:
#
#   * npm   — `generate-license-file` extracts the verbatim LICENSE text of every
#             production dependency of the pnpm workspace (config: scripts/glf.config.cjs).
#   * cargo — `cargo-about` extracts the verbatim license text of every crate that
#             compiles into the shipped `gateway` binary (config: apps/gateway/about.toml,
#             template: apps/gateway/about.hbs).
#
# The only human-written content is the header (scripts/notice-header.txt) and the
# review preamble (emitted by scripts/notice-review.mjs). Packages that are not OSS
# are excluded from NOTICE and listed in NOTICE-REVIEW.txt for manual / CELA review.
#
# Usage:
#   scripts/generate-notice.sh            Regenerate NOTICE and NOTICE-REVIEW.txt.
#   scripts/generate-notice.sh --check    Verify the committed files are up to date
#                                         (non-zero exit if stale); writes nothing.
#
# Environment:
#   SKIP_CARGO=1   Reuse the cached Rust section instead of re-running cargo-about
#                  (cargo metadata resolution is slow). Requires a prior full run.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

MODE="generate"
if [[ "${1:-}" == "--check" ]]; then
  MODE="check"
elif [[ -n "${1:-}" ]]; then
  echo "generate-notice.sh: unknown argument '$1' (expected --check or none)" >&2
  exit 2
fi

BUILD_DIR="$REPO_ROOT/.notice-build"
mkdir -p "$BUILD_DIR"
JS_OUT="$BUILD_DIR/NOTICE-js.txt"
RUST_CACHE="$BUILD_DIR/NOTICE-rust.txt"

# Where results are written (real files in generate mode, temp files in check mode).
if [[ "$MODE" == "check" ]]; then
  NOTICE_OUT="$(mktemp)"
  REVIEW_OUT="$(mktemp)"
  trap 'rm -f "$NOTICE_OUT" "$REVIEW_OUT"' EXIT
else
  NOTICE_OUT="$REPO_ROOT/NOTICE"
  REVIEW_OUT="$REPO_ROOT/NOTICE-REVIEW.txt"
fi

echo "==> [1/4] npm: extracting production license texts with generate-license-file" >&2
npx --yes generate-license-file@4 \
  --config scripts/glf.config.cjs \
  --output "$JS_OUT" \
  --overwrite \
  --ci \
  --no-spinner

echo "==> [2/4] cargo: extracting gateway crate license texts with cargo-about" >&2
if [[ "${SKIP_CARGO:-}" == "1" ]]; then
  if [[ -f "$RUST_CACHE" ]]; then
    echo "    SKIP_CARGO=1 — reusing cached $RUST_CACHE" >&2
  else
    echo "generate-notice.sh: SKIP_CARGO=1 but no cached Rust section exists." >&2
    echo "Run once without SKIP_CARGO to populate $RUST_CACHE." >&2
    exit 1
  fi
else
  ( cd "$REPO_ROOT/apps/gateway" && cargo about generate about.hbs ) > "$RUST_CACHE"
fi

echo "==> [3/4] assembling NOTICE" >&2
{
  cat "$REPO_ROOT/scripts/notice-header.txt"
  printf '\n\n'
  printf '===============================================================================\n'
  printf 'npm packages (production dependencies)\n'
  printf '===============================================================================\n\n'
  cat "$JS_OUT"
  printf '\n\n'
  printf '===============================================================================\n'
  printf 'Rust crates (gateway binary)\n'
  printf '===============================================================================\n\n'
  cat "$RUST_CACHE"
} > "$NOTICE_OUT"

echo "==> [4/4] building NOTICE-REVIEW.txt (packages needing manual / CELA review)" >&2
pnpm licenses list --prod --json 2>/dev/null \
  | node "$REPO_ROOT/scripts/notice-review.mjs" "$REPO_ROOT" \
  > "$REVIEW_OUT"

if [[ "$MODE" == "check" ]]; then
  status=0
  if ! diff -q "$REPO_ROOT/NOTICE" "$NOTICE_OUT" >/dev/null 2>&1; then
    echo "NOTICE is out of date. Run 'pnpm notice' and commit the result." >&2
    status=1
  fi
  if ! diff -q "$REPO_ROOT/NOTICE-REVIEW.txt" "$REVIEW_OUT" >/dev/null 2>&1; then
    echo "NOTICE-REVIEW.txt is out of date. Run 'pnpm notice' and commit the result." >&2
    status=1
  fi
  if [[ "$status" -eq 0 ]]; then
    echo "NOTICE and NOTICE-REVIEW.txt are up to date." >&2
  fi
  exit "$status"
fi

echo "Wrote $(wc -l < "$NOTICE_OUT" | tr -d ' ') lines to NOTICE and $(wc -l < "$REVIEW_OUT" | tr -d ' ') lines to NOTICE-REVIEW.txt." >&2
