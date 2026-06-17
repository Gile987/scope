#!/bin/sh
# Regenerate the portal's runtime config from environment variables before
# nginx starts. This lets a single built image be promoted across environments
# while still pointing at the correct docs site per environment.
#
# Dropped into /docker-entrypoint.d/ so the stock nginx entrypoint runs it
# (and then starts nginx itself) — this script must NOT exec nginx.
set -eu

DOCS_BASE_URL="${SCOPE_DOCS_BASE_URL:-https://urban-disco-1qzzq7z.pages.github.io}"
CONFIG_PATH="/usr/share/nginx/html/config.js"

# Escape characters that are special inside a JS double-quoted string.
escaped_docs_base=$(printf '%s' "$DOCS_BASE_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')

cat > "$CONFIG_PATH" <<EOF
window.__SCOPE_CONFIG__ = Object.assign(
  { docsBaseUrl: "${escaped_docs_base}" },
  window.__SCOPE_CONFIG__
);
EOF

echo "portal: wrote ${CONFIG_PATH} (docsBaseUrl=${DOCS_BASE_URL})"
