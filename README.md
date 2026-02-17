# Coding Agent Workers with Real-Time Logging (MongoDB + Azure Managed Redis)

This experiment demonstrates a TypeScript-based API with **three coding agent workers** and **real-time log streaming** using Azure Container Apps:

- **API**: Express.js REST API that routes coding requests to different agent workers and streams logs via SSE
- **coder-acp-claude-code**: Claude Code agent using Agent Client Protocol (ACP)
- **coder-acp-copilot**: GitHub Copilot agent using Agent Client Protocol (ACP)
- **Storage Queues**: Separate queue per worker for message routing
- **CosmosDB (MongoDB API)**: Shared database for request status tracking and log persistence
- **Azure Managed Redis**: Real-time log publishing via Pub/Sub
- **Azure Key Vault**: Secure storage for API keys and auth state

## Architecture

```
                                    ┌─────────────────┐     ┌─────────────────────────┐
                                ┌──▶│ Queue claude    │────▶│ coder-acp-claude-code   │───┐
┌─────────┐     ┌───────────┐   │   └─────────────────┘     │ (Claude Code ACP)       │   │
│ Client  │────▶│ API (ACA) │───┤                           └─────────────────────────┘   │
└─────────┘     └───────────┘   │   ┌─────────────────┐     ┌─────────────────────────┐   │
       ▲        │           │   ├──▶│ Queue copilot   │────▶│ coder-acp-copilot       │───┤
       │        │  SSE ◀────┼───┤   └─────────────────┘     │ (Copilot ACP)           │   │
       │        └───────────┘   │                           └─────────────────────────┘   │
       │                        │   ┌─────────────────┐     ┌─────────────────────────┐   │
       │                            └─────────────────┘     │ (Playwright + VS Code)  │   │
       │                                                    └─────────────────────────┘   │
       │        ┌─────────────────┐     ┌─────────────────┐                               │
       └────────│  Redis Pub/Sub  │◀────│   Log Events    │◀──────────────────────────────┤
                └─────────────────┘     └─────────────────┘                               │
                                                                                          │
                                        ┌─────────────────┐                               │
                                        │    CosmosDB     │◀──────────────────────────────┘
                                        └─────────────────┘
```

## Features

### Coding Agent Workers

| Worker | Agent | Protocol | Use Case |
|--------|-------|----------|----------|
| coder-acp-claude-code | Claude Code | ACP (stdio) | AI coding with Claude |
| coder-acp-copilot | GitHub Copilot | ACP (stdio) | AI coding with Copilot CLI |

### Real-Time Log Streaming
Workers publish step-by-step progress logs that clients can stream in real-time:
- **Redis Pub/Sub** for instant log delivery (milliseconds latency)
- **Server-Sent Events (SSE)** for browser and CLI compatibility
- **CosmosDB persistence** for log replay and history

## CLI Usage

The CLI provides an easy way to submit requests and stream logs.

```bash
export $(azd env get-values | xargs)

# Run demo TUI with concurrent requests to all coders
pnpm cli demo -m "create a hello world app" -c 2 -u $API_ENDPOINT

# Submit to Copilot and stream logs
pnpm cli submit -m "Explain this code: const x = 42;" -w coder-acp-copilot -u $API_ENDPOINT

# Submit to Claude Code
pnpm cli submit -m "Create a hello world function in Python" -w coder-acp-claude-code -u $API_ENDPOINT

# Submit to VS Code Web

# Submit without streaming logs
pnpm cli submit -m "Say hello" -w coder-acp-copilot -u $API_ENDPOINT --no-stream

# Check request status
pnpm cli status <request-id> -u $API_ENDPOINT

# Stream logs for existing request
pnpm cli logs <request-id> -u $API_ENDPOINT --from-start

# List all requests
pnpm cli list -u $API_ENDPOINT
```

## API Endpoints

### Health Check
```bash
export $(azd env get-values | xargs) && curl $API_ENDPOINT/health
```

### Get Request Status
```bash
curl $API_ENDPOINT/api/v1/requests/:id
```

### Stream Logs (SSE)
```bash
curl -N "$API_ENDPOINT/api/v1/requests/:id/logs?fromStart=true"
```

## Local Development

### Prerequisites

- Node.js 22+
- pnpm
- Docker & Docker Compose
- Azure CLI (for Azure deployment)

### Local Development with Docker Compose

```bash
# Start local services (MongoDB, Redis, Azurite)
pnpm docker:up

# Copy environment template
cp .env.example .env

# Set required credentials in .env:
# - ANTHROPIC_API_KEY (for coder-acp-claude-code)
# - GITHUB_TOKEN (for coder-acp-copilot)

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run API locally
pnpm dev:api

# Run workers locally (separate terminals)
pnpm dev:coder-acp-claude-code
pnpm dev:coder-acp-copilot
```

### Environment Variables

See `.env.example` for all required variables.

## Deployment

```bash
# Login to Azure
azd auth login

# Create environment
azd env new myenv

# Deploy
azd up
```

### Configure Worker Credentials

After deployment, set the required credentials for each worker:

```bash
# Set Anthropic API key for Claude Code worker
azd env get-values | xargs -I {} sh -c 'export {}' && \
az containerapp update --name coder-acp-claude-code \
  --resource-group $(azd env get-values | grep AZURE_RESOURCE_GROUP | cut -d= -f2 | tr -d '"') \
  --set-env-vars "ANTHROPIC_API_KEY=<your-anthropic-api-key>"

# Set GitHub token for Copilot worker
az containerapp update --name coder-acp-copilot \
  --resource-group $(azd env get-values | grep AZURE_RESOURCE_GROUP | cut -d= -f2 | tr -d '"') \
  --set-env-vars "GITHUB_TOKEN=<your-github-token>"
```

#### VS Code Web Auth State

The VS Code Web worker requires GitHub authentication via Playwright browser state stored in Key Vault:

```bash
# Upload auth state (write-only, stored in Key Vault)
curl -X PUT "$(azd env get-values | grep API_ENDPOINT | cut -d= -f2 | tr -d '"')/api/v1/auth/vscode-web" \
  -H "Content-Type: application/json" \
  -d @github-storage.json

# Check if auth state exists
curl "$(azd env get-values | grep API_ENDPOINT | cut -d= -f2 | tr -d '"')/api/v1/auth/vscode-web/status"

# Delete auth state
curl -X DELETE "$(azd env get-values | grep API_ENDPOINT | cut -d= -f2 | tr -d '"')/api/v1/auth/vscode-web"
```

### Deploy Individual Services

Use the postprovision script to build and deploy specific services:

```bash
# Deploy all services
./infra/hooks/postprovision.sh

# Deploy only a specific service
./infra/hooks/postprovision.sh api
./infra/hooks/postprovision.sh coder-acp-claude-code
./infra/hooks/postprovision.sh coder-acp-copilot
```

## Azure Resources

- **Azure Container Apps Environment**: Hosting for API and workers
- **Azure Container Registry**: Container image storage
- **Azure Cosmos DB (MongoDB API)**: Request and log persistence
- **Azure Storage Account**: Queue-based message routing
- **Azure Managed Redis**: Real-time log pub/sub
- **Azure Key Vault**: API keys, auth state storage

## Project Structure

```
├── azure.yaml
├── docker-compose.yml
├── .env.example
├── infra/
│   ├── main.bicep
│   ├── resources.bicep
│   └── modules/
├── apps/
│   ├── api/
│   │   ├── Dockerfile
│   │   └── src/index.ts
│   ├── cli/
│   ├── judge/
│   │   └── Dockerfile
│   ├── portal/
│   │   └── Dockerfile
│   └── workers/
│       ├── coder-acp-claude-code/
│       │   └── Dockerfile
│       ├── coder-acp-copilot/
│       │   └── Dockerfile
│           └── Dockerfile
├── packages/
│   └── shared/src/
└── package.json
```

## License

MIT
