#!/usr/bin/env bash
# =============================================================================
# ensure-dev-certs.sh — provision a locally-trusted TLS cert for entra-local
# =============================================================================
# MSAL requires an https:// authority (no localhost exemption), so the local
# Entra emulator must serve HTTPS with a certificate the browser already trusts.
# This uses mkcert to install a local CA into the OS/browser trust store (once)
# and mint a `localhost` leaf cert. Both steps are idempotent, so this is safe to
# run on every `pnpm docker:dev:*` bring-up — after the first run it is a no-op
# and does not re-prompt.
#
# Invoked automatically by scripts/dev-compose.sh when the `auth` profile is
# active. The host key stays `0600` (owner-only); the entra-local-certs-init
# compose service stages a copy into a named volume with UID 1000 ownership so
# the emulator can read it on rootless / UID-remapped container engines too.
# =============================================================================
set -euo pipefail

# Ensure common tool paths are available (Homebrew, etc.).
for p in /usr/local/bin /opt/homebrew/bin; do
  [[ -d "$p" ]] && [[ ":$PATH:" != *":$p:"* ]] && export PATH="$p:$PATH"
done

CERT_DIR="${DEV_CERT_DIR:-.certs}"
CERT_FILE="$CERT_DIR/entra-local.pem"
KEY_FILE="$CERT_DIR/entra-local-key.pem"

if ! command -v mkcert >/dev/null 2>&1; then
  cat >&2 <<'EOF'
[ensure-dev-certs] mkcert is required for local auth (HTTPS) but was not found.

Install it, then re-run your command:
  macOS:        brew install mkcert nss
  Linux (apt):  sudo apt install libnss3-tools && \
                curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64" && \
                chmod +x mkcert-v*-linux-amd64 && sudo mv mkcert-v*-linux-amd64 /usr/local/bin/mkcert
  Windows:      choco install mkcert   (or: scoop install mkcert)

More: https://github.com/FiloSottile/mkcert
EOF
  exit 1
fi

# Install the local CA into the system/browser trust store. Idempotent: mkcert
# skips (and does not prompt) when the CA is already trusted.
mkcert -install >/dev/null 2>&1 || mkcert -install

mkdir -p "$CERT_DIR"

if [[ -f "$CERT_FILE" && -f "$KEY_FILE" ]]; then
  echo "[ensure-dev-certs] cert already present at $CERT_FILE"
  exit 0
fi

echo "[ensure-dev-certs] minting localhost cert -> $CERT_FILE"
mkcert -cert-file "$CERT_FILE" -key-file "$KEY_FILE" localhost 127.0.0.1 ::1 >/dev/null
echo "[ensure-dev-certs] done. Browser trusts https://localhost (via mkcert local CA)."
