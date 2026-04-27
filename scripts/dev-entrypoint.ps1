# Dev entrypoint for Windows containers.
# Equivalent of scripts/dev-entrypoint.sh for Linux containers.
#
# Required env var:
#   SERVICE_DIR - relative path from C:\app\apps\ (e.g., "workers/coder-acp-copilot")

$ErrorActionPreference = 'Stop'

if (-not $env:SERVICE_DIR) {
    Write-Error "ERROR: SERVICE_DIR env var is required"
    exit 1
}

Write-Host "[dev-entrypoint] Starting shared package watcher..."
$sharedJob = Start-Job -ScriptBlock {
    Set-Location C:\app\packages\shared
    npx tsc --watch --preserveWatchOutput
}

Write-Host "[dev-entrypoint] Starting $env:SERVICE_DIR with tsx watch..."
Set-Location "C:\app\apps\$env:SERVICE_DIR"
npx tsx watch src/index.ts
