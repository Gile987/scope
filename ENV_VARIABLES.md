# Environment Variables for Criteria System

The sophisticated criteria system can be configured via environment variables in docker-compose or .env files.

## CLI Configuration

### SCOPE_API_URL
**Default:** `http://localhost:3100`
**Type:** URL string

Base URL of the Scope API used by all CLI commands. Override this to point the CLI at a remote or Docker-hosted API instance.

## LLM Configuration (Criteria Prompt Generation)

### GITHUB_MODELS_API_KEY
**Required for AI prompt generation**
**Type:** string

GitHub personal access token (with the `models` read permission) used to authenticate with GitHub Models (`https://models.inference.ai.azure.com`) via the Azure AI Inference SDK. When set, the API can auto-generate evaluation prompts from natural-language behavior descriptions during criteria creation.

> **Note:** This is separate from `GITHUB_TOKEN`, which is used by the Judge and worker services for Copilot SDK / ACP access and does **not** need the `models` permission.

### LLM_MODEL
**Default:** `gpt-4.1`
**Type:** string

The model name to use for criteria prompt generation via GitHub Models. Examples: `gpt-4.1`, `gpt-4o`, `gpt-4.1-mini`.

## Judge Strategy Configuration

### JUDGE_STRATEGY
**Default:** `bundled`
**Options:** `bundled` | `independent`

- `bundled`: Evaluate all criteria in one judge session (faster, less granular)
- `independent`: Evaluate criteria separately in topological order with DAG awareness (slower, more accurate, skips descendants of failures)

### JUDGE_MAX_PARALLELISM
**Default:** `3`
**Type:** integer

Maximum number of criteria to evaluate in parallel when using `independent` strategy.

### JUDGE_TIMEOUT
**Default:** `300000` (5 minutes)
**Type:** integer (milliseconds)

Timeout for each Copilot SDK `sendAndWait` call. If the LLM takes longer than this to complete a response, the call will fail with a timeout error. Increase this if you see `Timeout after Xms waiting for session.idle` errors.

## Feedback Configuration

### FEEDBACK_MAX_CRITERIA
**Default:** `1`
**Type:** integer

Maximum number of failed criteria to mention in feedback per iteration. The system automatically filters to root-cause failures only (failures whose parent criteria passed).

### FEEDBACK_DESCENDANT_GUARD
**Default:** `true`
**Type:** boolean (`true` | `false`)

When enabled, prevents feedback from hinting about descendant criteria (requirements that depend on the failed criterion). This ensures developers discover requirements progressively.

### CRITERIA_DIR
**Default:** `/app/config/criteria` (in Docker), `./config/criteria` (local)
**Type:** path

Path to the directory containing criteria definition YAML files for v2 scenarios.

## Portal Feature Flags

### VITE_SHOW_PASS_AT_K
**Default:** (not set, hidden)
**Type:** `"true"` | (any other value or unset)

When set to `"true"`, displays the Pass@k metrics table on the Insights page. By default, this table is hidden. This is a Vite env var and must be prefixed with `VITE_` to be exposed to the frontend.

## Setting Variables

### Docker Compose
Variables can be set in docker-compose.yml or overridden via environment:

```bash
JUDGE_STRATEGY=independent docker compose up
```

### Local Development
Create a `.env` file in the project root:

```bash
JUDGE_STRATEGY=independent
JUDGE_MAX_PARALLELISM=5
FEEDBACK_MAX_CRITERIA=2
FEEDBACK_DESCENDANT_GUARD=true
```

## Example Configurations

### Fast Evaluation (Default)
```env
JUDGE_STRATEGY=bundled
```

### Thorough Evaluation with DAG
```env
JUDGE_STRATEGY=independent
JUDGE_MAX_PARALLELISM=3
FEEDBACK_MAX_CRITERIA=1
FEEDBACK_DESCENDANT_GUARD=true
```

### Debug Mode (Show More Failures)
```env
JUDGE_STRATEGY=independent
JUDGE_MAX_PARALLELISM=5
FEEDBACK_MAX_CRITERIA=3
FEEDBACK_DESCENDANT_GUARD=false
```

## Report Generator Configuration

### AZURE_STORAGE_QUEUE_REPORT
**Default:** `report-queue`
**Type:** string

Azure Storage Queue name for report generation jobs. The API enqueues messages here when a report is requested; the report-generator worker polls this queue.

### REPORT_MODEL
**Default:** `gpt-4.1`
**Type:** string

The LLM model used by the report-generator worker (via the Copilot SDK) to generate run analysis reports. Examples: `gpt-4.1`, `gpt-4o`, `claude-sonnet-4`.

### SCOPE_MT_API_URL
**Default:** `http://localhost:3001` (local), `http://api:80` (Docker)
**Type:** URL string

Base URL of the Scope API. The report-generator worker calls this to fetch run data (summary, turns, criteria trajectory) via REST tools during report generation.

### SESSION_TIMEOUT_MS
**Default:** `300000` (5 minutes)
**Type:** integer (milliseconds)

Timeout for the Copilot SDK session used by the report-generator worker. If the LLM takes longer than this to generate a report, the session will be terminated and the report marked as failed.

### GIT_COMMIT
**Default:** `development`
**Type:** string

Git commit hash embedded in reporter metadata. Automatically set during CI/CD builds. Used to track which version of the report-generator produced a given report.

## Token Manager Configuration

### TOKEN_MANAGER_URL
**Default:** (not set)
**Type:** URL string

Base URL of the Token Manager service. Workers, judge, and report-generator use the `TokenManagerClient` to dynamically acquire keys via `POST /api/v1/keys/acquire` (round-robin across enabled keys).

In Kubernetes, no static token secrets (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`) are injected into pods — all keys are acquired from the Token Manager at runtime. In local dev / Docker Compose, env vars can still be set as a fallback (the `TokenManagerClient` checks env vars first before calling the Token Manager HTTP API).

- **Docker Compose:** `http://token-manager:80`
- **Kubernetes:** `http://token-manager-service.scoped.svc.cluster.local:80`
- **Local dev:** Leave unset to use env var fallback (`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, etc.)

### AZURE_KEYVAULT_URI
**Type:** URL string (token-manager only) — **Required**

Azure KeyVault URI for storing token secret values. The Token Manager uses `KeyVaultTokenStore` with `DefaultAzureCredential`.

- **Docker Compose:** Provided automatically via Lowkey Vault (Azure KV emulator): `https://lowkey-vault:8443`
- **Kubernetes:** Azure Key Vault URI (e.g., `https://my-vault.vault.azure.net`)
- **Local dev (no Docker):** Not supported without a vault; use Docker Compose

### VALIDATION_INTERVAL_MS
**Default:** `300000` (5 minutes)
**Type:** integer (milliseconds)

How often the Token Manager's scheduler validates all active tokens against their provider APIs. Each token is tested (e.g., GitHub PAT → `GET /user`, Anthropic → `GET /v1/models`) and its `lastValidationStatus` is updated in MongoDB.

### TOKEN_MANAGER_PORT
**Default:** `3102`
**Type:** integer (Docker Compose only)

Host port mapping for the token-manager service in Docker Compose.

## DevProxy Configuration (HAR Capture)

### DEV_PROXY_ENABLED
**Default:** `false`
**Type:** boolean (`true` | `false`)

Enables DevProxy integration for capturing HTTP traffic as HAR files. When `true`, the worker starts/stops DevProxy recording around each coding agent session, extracts tool calls from the HAR, and uploads the HAR to blob storage.

- **Docker Compose:** Set via `DEV_PROXY_ENABLED=true` in `.env` or inline
- **Kubernetes:** Set in the deployment manifest env vars (auto-set when sidecar is present)

### DEV_PROXY_API_URL
**Default:** `http://localhost:18897`
**Type:** URL string

URL of the DevProxy REST API. The `DevProxyClient` uses this to start/stop recording, check status, and download the CA certificate.

- **Docker Compose:** `http://devproxy-copilot:18897` (separate service)
- **Kubernetes:** `http://localhost:18897` (sidecar in same pod)

### DEV_PROXY_HAR_DIR
**Default:** `/har-output`
**Type:** path

Directory where DevProxy writes HAR files. Shared between the DevProxy process and the worker via a volume mount.

### DEVPROXY_COPILOT_API_PORT
**Default:** `18800`
**Type:** integer (Docker Compose only)

Host port mapping for the Copilot DevProxy REST API in Docker Compose.
