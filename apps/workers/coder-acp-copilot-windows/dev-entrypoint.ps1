# Dev entrypoint for coder-acp-copilot-windows
# Runs the worker with tsx watch for hot-reload during development.

$ErrorActionPreference = "Stop"

Write-Host "Starting coder-acp-copilot-windows in development mode..."
Write-Host "  Worker: $env:WORKER_NAME"
Write-Host "  Queue:  $env:QUEUE_NAME"

Set-Location "C:\app\apps\workers\coder-acp-copilot-windows"
& npx tsx watch src/index.ts
