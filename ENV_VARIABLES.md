# Environment Variables for Criteria System

The sophisticated criteria system can be configured via environment variables in docker-compose or .env files.

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
