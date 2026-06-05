---
name: "scope-api"
description: "Query and control the Scope platform API for analyzing benchmark data, managing runs/requests, skills, agents, reports, and insights. Use when the user asks about SCOPE data, wants to trigger runs, check status, generate reports, or interact with the SCOPE platform programmatically."
---

## Scope API Skill

The Scope platform benchmarks AI coding agents. This skill explains how to query and control it.

### Base URL

```
http://localhost:${API_PORT}
```

The `API_PORT` variable is defined in the project `.env` file (default: `3116`). Always read it from the environment or `.env` before making calls.

### Authentication

Most endpoints require a bearer token. Pass it as:
```
-H "Authorization: Bearer $SCOPE_TOKEN"
```

If the user has the SCOPE CLI configured, the token may be available via environment or the CLI config.

### Before Making API Calls

**Always fetch the OpenAPI spec first** to understand available endpoints, required parameters, and response schemas:

```bash
curl -s http://localhost:$API_PORT/openapi.json
```

Parse it with `jq` to find the relevant endpoint and its schema before constructing your API call. For example:

```bash
# Find endpoints matching a keyword
curl -s http://localhost:$API_PORT/openapi.json | jq '.paths | keys[] | select(contains("requests"))'

# Get schema for a specific endpoint
curl -s http://localhost:$API_PORT/openapi.json | jq '.paths["/api/v1/requests"]'
```

### Key Endpoint Groups

- **System**: `/health`, `/ready`, `/about`, `/api/v1/version`
- **Requests & Runs**: `/api/v1/requests/*` (create, cancel, retry, pause, resume, bulk ops, logs, HAR, video, snapshots, tool-calls)
- **Skills**: `/api/v1/skills/*` (discover, search, external, resolve, revisions)
- **Agents**: `/api/v1/agents/*` (CRUD, versions)
- **Reports & Insights**: `/api/v1/reports/*`, `/api/v1/insights/*` (trigger, bulk, upvote/downvote)
- **Criteria & Prompt Features**: `/api/v1/criteria/*`, `/api/v1/prompt-features/*` (MDP, graph, seed, generate, extract)
- **Task Prompts**: `/api/v1/task-prompts/*` (generate, extract features)
- **Models**: `/api/v1/models/*` (list, sync)
- **Feature Flags**: `/api/v1/feature-flags`

### Usage Pattern

When the user asks about SCOPE data or wants to control SCOPE:

1. **Fetch the OpenAPI spec** from `http://localhost:$API_PORT/openapi.json`
2. **Find the relevant endpoint** and inspect its parameters/schemas
3. **Make the API call** with `curl` and parse results with `jq`
4. For complex queries, combine multiple API calls

### Example Workflow

```bash
# 1. Fetch spec and find the endpoint you need
curl -s http://localhost:$API_PORT/openapi.json | jq '.paths["/api/v1/requests"].get'

# 2. Make the call
curl -s http://localhost:$API_PORT/api/v1/requests | jq '.[:5]'

# 3. Drill into details
curl -s http://localhost:$API_PORT/api/v1/requests/{id} | jq .
```
