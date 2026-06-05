<#
.SYNOPSIS
  Registers the coder-acp-copilot-windows agent and its current version with the Scope API.
  Designed to run inside the worker container where env vars are baked in at build time.

.DESCRIPTION
  1. Waits for the API to become healthy.
  2. Upserts the agent document from agent.json (idempotent).
  3. Registers the current version using baked-in env vars (COPILOT_CLI_VERSION, BUILD_TIME, GIT_COMMIT).

.PARAMETER ApiUrl
  Base URL of the Scope API. Defaults to the in-cluster service address.
#>
param(
  [string]$ApiUrl = "http://api.scoped.svc.cluster.local:80"
)

$ErrorActionPreference = "Stop"

$AgentId = "coder-acp-copilot-windows"
$QueueName = "queue-coder-acp-copilot-windows"

# Build version strings from env vars baked into the worker image
$copilotCliVersion = if ($env:COPILOT_CLI_VERSION) { $env:COPILOT_CLI_VERSION } else { "unknown" }
$AgentVersion = "copilot-$copilotCliVersion"

$buildTime = if ($env:BUILD_TIME) { $env:BUILD_TIME } else { "unknown" }
$gitCommit = if ($env:GIT_COMMIT) { $env:GIT_COMMIT } else { "unknown" }
$WorkerVersion = "$AgentVersion-$buildTime-$gitCommit"

Write-Host "Registering version for $AgentId"
Write-Host "  agentVersion:  $AgentVersion"
Write-Host "  workerVersion: $WorkerVersion"

# Wait for API health
Write-Host "Waiting for API at $ApiUrl..."
while ($true) {
  try {
    $null = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 5
    break
  } catch {
    Write-Host "API not ready, retrying in 5s..."
    Start-Sleep -Seconds 5
  }
}
Write-Host "API is ready."

# Upsert agent document (idempotent - creates if missing, updates if exists)
Write-Host "Upserting agent document..."
$agentJsonPath = Join-Path $PSScriptRoot "agent.json"
if (-not (Test-Path $agentJsonPath)) {
  # Fall back to current directory (when run from WORKDIR in container)
  $agentJsonPath = "agent.json"
}
$agentJson = Get-Content -Raw $agentJsonPath

try {
  $null = Invoke-RestMethod -Uri "$ApiUrl/api/v1/agents" `
    -Method Post `
    -ContentType "application/json" `
    -Body $agentJson
  Write-Host "Agent upsert successful."
} catch {
  Write-Warning "Agent upsert failed: $_"
  Write-Warning "Continuing anyway (agent may already exist)..."
}

# Register version
Write-Host "Registering version..."
$versionBody = @{
  agentVersion = $AgentVersion
  workerVersion = $WorkerVersion
  components = @{ COPILOT_CLI_VERSION = $copilotCliVersion }
  gitCommit = $gitCommit
  buildTime = $buildTime
  imageTag = $WorkerVersion
  queueName = $QueueName
} | ConvertTo-Json -Compress

try {
  $null = Invoke-RestMethod -Uri "$ApiUrl/api/v1/agents/$AgentId/versions" `
    -Method Post `
    -ContentType "application/json" `
    -Body $versionBody
  Write-Host "Version registration successful."
} catch {
  Write-Error "Version registration failed: $_"
  exit 1
}

Write-Host "Version registration complete."
