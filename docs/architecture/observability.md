# Observability

Application-level telemetry for Scope services using Azure Application Insights and the modern `@azure/monitor-opentelemetry` OpenTelemetry distro.

## Data Flow

```mermaid
graph TB
    subgraph Services
        API[scope-api]
        W1[coder-acp-copilot]
        W2[coder-acp-copilot-windows]
        W3[coder-acp-claude-code]
        W4[coder-vscode-electron]
        J[scope-judge]
        SCH[scope-scheduler]
        TM[scope-token-manager]
        PP[scope-post-processor]
        RG[scope-report-generator]
        MS[model-scanners]
    end

    subgraph "Telemetry Package<br/>(packages/telemetry)"
        INIT[initTelemetry]
        METER["OTel Meter API<br/>(Histogram / Counter)"]
        TRACE["trackTrace<br/>(gated by TELEMETRY_LOG_LEVEL)"]
        EVENT["trackEvent<br/>(Counter API)"]
    end

    subgraph "Auto-Instrumentation<br/>(useAzureMonitor)"
        HTTP[HTTP requests/responses]
        DEPS[Dependencies: MongoDB, Redis, outgoing HTTP]
        EXC[Unhandled exceptions]
    end

    subgraph Azure
        EXPORT["Azure Monitor Exporter<br/>(HTTPS POST → Breeze /v2.1/track)"]
        AI[Application Insights]
        LA[Log Analytics Workspace]
        GRAFANA[Azure Managed Grafana]
        ALERTS[Alert Rules]
    end

    subgraph "Secret Delivery"
        KV[Azure Key Vault]
        ESO[External Secrets Operator]
        SECRET[K8s Secret → env var]
    end

    API & W1 & W2 & W3 & W4 & J & SCH & TM & PP & RG & MS --> INIT

    INIT --> HTTP
    INIT --> DEPS
    INIT --> EXC
    INIT --> METER
    INIT --> TRACE
    INIT --> EVENT

    METER -->|"OTel SDK"| EXPORT
    TRACE -->|"structured JSON → console"| EXPORT
    EVENT -->|"OTel SDK"| EXPORT
    HTTP -->|"OTel SDK"| EXPORT
    DEPS -->|"OTel SDK"| EXPORT
    EXC -->|"OTel SDK"| EXPORT

    EXPORT -->|"HTTPS POST<br/>Azure Breeze JSON"| AI
    AI -->|"ingestion pipeline"| LA
    LA -->|"KQL via Azure Monitor<br/>data source (HTTPS)"| GRAFANA
    LA -->|"KQL scheduled queries"| ALERTS

    KV -->|"HTTPS<br/>Azure REST API"| ESO
    ESO -->|"K8s API"| SECRET
```

## Transport Protocols

| Hop | Protocol | Format | Notes |
|-----|----------|--------|-------|
| OTel SDK → App Insights | HTTPS POST to Breeze endpoint (`/v2.1/track`) | Azure Monitor `TelemetryItem` JSON (not OTLP) | Endpoint URL from connection string `IngestionEndpoint` |
| App Insights → Log Analytics | Internal Azure pipeline | — | Automatic, no user configuration |
| Log Analytics → Grafana | HTTPS | KQL queries via Azure Monitor data source plugin | Grafana polls on dashboard refresh interval |
| Log Analytics → Alert Rules | HTTPS | KQL scheduled query evaluation | Configured per alert rule |
| Key Vault → ESO | HTTPS | Azure Key Vault REST API | ESO polls on `refreshInterval` |
| ESO → Pod | K8s API | K8s Secret mounted as `envFrom` | kubelet injects as environment variable |

> **Note:** Despite being built on OpenTelemetry, the Azure Monitor distro does **not** use the standard OTLP protocol (gRPC or HTTP/protobuf). The `@azure/monitor-opentelemetry-exporter` converts OTel spans, metrics, and logs into Azure's proprietary `TelemetryItem` JSON envelope and POSTs them to the Breeze ingestion endpoint.

## Telemetry Module

Located at `packages/telemetry/`. All services import from `"telemetry"`.

### Initialization

```typescript
import { initTelemetry } from "telemetry";

// Must be called BEFORE any other imports that make HTTP calls
// (Express, MongoDB, etc.) so OTel auto-instrumentation hooks are applied.
initTelemetry("scope-api");
```

`initTelemetry(serviceName)` calls `useAzureMonitor()` with:
- Connection string from `APPLICATIONINSIGHTS_CONNECTION_STRING`
- Sampling ratio from `TELEMETRY_SAMPLING_RATIO` (default 1.0)
- Live Metrics enabled
- `OTEL_SERVICE_NAME` set to `serviceName`

### Graceful No-Op

When `APPLICATIONINSIGHTS_CONNECTION_STRING` is unset, `initTelemetry()` returns early. All helper functions (`trackMetric`, `trackTrace`, `trackEvent`) check `isTelemetryEnabled()` and return immediately — zero runtime cost, no errors, no conditional logic needed at call sites.

### Custom Metrics API

| Helper | OTel Instrument | Use Case |
|--------|----------------|----------|
| `trackMetric({ name, value, properties })` | Histogram | Timing and distribution metrics |
| `trackEvent({ name, properties })` | Counter | Occurrence counting |
| `trackTrace({ message, severityLevel, properties })` | Console JSON → auto-collector | Log forwarding (level-gated) |
| `trackDependency({ name, duration, success, ... })` | Histogram | External call tracking |

### Shutdown

```typescript
import { shutdownTelemetry } from "telemetry";

process.on("SIGTERM", async () => {
  await shutdownTelemetry(); // flushes pending telemetry
  process.exit(0);
});
```

## Worker Metrics


| Metric | Type | Description | Dimensions |
|--------|------|-------------|------------|
| `worker.run_duration_ms` | Histogram | Total run processing time | `runId`, `workerType`, `stopReason` |
| `worker.first_ai_call_ms` | Histogram | Time from run start to first AI interaction | `runId`, `workerType` |
| `worker.cold_start_ms` | Histogram | Container uptime at first run (`process.uptime() * 1000`) | `workerType` |
| `worker.subprocess_idle_s` | Histogram | Gap between subprocess protocol events (hang detection) | `runId`, `workerType` |
| `worker.run_started` | Counter | Run start event | `runId`, `workerType`, `model` |


### Idle Monitoring

A `setInterval(30s)` timer runs during active runs. If the gap since the last subprocess protocol event exceeds 60 seconds, a `worker.subprocess_idle_s` metric is emitted. This enables real-time detection of subprocess hangs before the run times out. The interval is cleared in both success and error paths.

### First AI Call Detection

`isFirstAiCallSignal(msg)` detects the first AI interaction by checking for:
- `"createTurn"` string in the message
- JSON-parseable messages with a `type` field

## API Instrumentation

The API calls `initTelemetry("scope-api")` at startup. No custom metrics — relies entirely on auto-instrumentation for:
- HTTP request/response traces (Express routes)
- Dependency tracking (MongoDB, Redis, Azure Storage, outgoing HTTP)
- Unhandled exception capture

## Judge Metrics

Emitted by the `scope-judge` Express service in the POST `/api/v1/evaluate` handler.

| Metric | Type | Description | Dimensions |
|--------|------|-------------|------------|
| `judge.evaluation_duration_ms` | Histogram | Total time for one evaluation request | `requestId` |
| `judge.blob_download_ms` | Histogram | Time to download + extract workspace snapshot | `requestId` |
| `judge.criteria_count` | Histogram | Number of criteria evaluated per request | `requestId` |
| `judge.evaluation_started` | Counter | Evaluation started event | `requestId`, `strategy` |
| `judge.evaluation_completed` | Counter | Evaluation completed event | `requestId` |

## Scheduler Metrics

Emitted by the `scope-scheduler` service from its three independent loops.

| Metric | Type | Description | Dimensions |
|--------|------|-------------|------------|
| `scheduler.dispatch_cycle_ms` | Histogram | Request dispatch poll cycle duration | `service` |
| `scheduler.requests_dispatched` | Histogram | Requests dispatched per cycle | `service` |
| `scheduler.pp_dispatch_cycle_ms` | Histogram | Post-processor dispatch cycle duration | `service` |
| `scheduler.pp_requests_dispatched` | Histogram | Post-processor requests dispatched per cycle | `service` |
| `scheduler.reaper_sweep_ms` | Histogram | Stuck-run reaper sweep duration | `service` |
| `scheduler.reaper_runs_failed` | Histogram | Runs failed by reaper per sweep | `service` |
| `scheduler.cold_start_ms` | Histogram | Process startup time | `service` |
| `scheduler.dispatch_started` | Counter | Service startup event | `workerTypes` |

## Token Manager Metrics

Emitted by the `scope-token-manager` Express service. HTTP route latencies are auto-instrumented; custom metrics cover the periodic validation scheduler.

| Metric | Type | Description | Dimensions |
|--------|------|-------------|------------|
| `token_manager.validation_cycle_ms` | Histogram | Periodic token validation sweep time | `service` |
| `token_manager.tokens_validated` | Histogram | Tokens checked per validation cycle | `service` |
| `token_manager.tokens_invalidated` | Histogram | Tokens found invalid per cycle | `service` |
| `token_manager.cold_start_ms` | Histogram | Process startup time | `service` |
| `token_manager.service_started` | Counter | Service startup event | — |

## Post-Processor Metrics

Emitted by the `scope-post-processor` queue processor.

| Metric | Type | Description | Dimensions |
|--------|------|-------------|------------|
| `post_processor.processing_duration_ms` | Histogram | Handler execution time | `service`, `handlerType` |
| `post_processor.cold_start_ms` | Histogram | First message processing time | `service` |
| `post_processor.processing_started` | Counter | Processing started event | `handlerType`, `requestId` |
| `post_processor.processing_completed` | Counter | Processing completed event | `handlerType`, `requestId` |

## Report Generator Metrics

Emitted by the `scope-report-generator` queue processor.

| Metric | Type | Description | Dimensions |
|--------|------|-------------|------------|
| `report_generator.generation_duration_ms` | Histogram | Total report generation time | `service` |
| `report_generator.llm_session_duration_ms` | Histogram | Copilot SDK LLM session time | `service` |
| `report_generator.cold_start_ms` | Histogram | First message processing time | `service` |
| `report_generator.generation_started` | Counter | Generation started event | `requestId`, `reportId`, `templateId` |
| `report_generator.generation_completed` | Counter | Generation completed event | `requestId`, `reportId` |

## Model Scanner Metrics

Emitted by both `model-scanner-copilot` and `model-scanner-anthropic` K8s Jobs. Short-lived processes — **must call `shutdownTelemetry()` before exit** to flush pending telemetry.

| Metric | Type | Description | Dimensions |
|--------|------|-------------|------------|
| `model_scanner.scan_duration_ms` | Histogram | Total scan time | `service`, `provider` |
| `model_scanner.token_acquisition_ms` | Histogram | Token Manager API latency | `service`, `provider` |
| `model_scanner.models_found` | Histogram | Models discovered | `service`, `provider` |
| `model_scanner.scan_completed` | Counter | Scan completed event | `provider`, `added`, `removed`, `unchanged` |

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | *(none — telemetry disabled)* | Connection string from App Insights resource |
| `TELEMETRY_SAMPLING_RATIO` | `1.0` | Fraction of telemetry to sample (0.0–1.0) |
| `TELEMETRY_LOG_LEVEL` | `Warning` | Minimum severity for subprocess log forwarding to App Insights |

## Deployment

### Secret Delivery

The connection string flows from Azure Key Vault to pods via External Secrets Operator:

1. **Key Vault** stores `appinsights-connection-string` (provisioned by `scope-core-infra`)
2. **ExternalSecret** `appinsights-secrets` references the KV secret via `ClusterSecretStore`
3. **Workers** get the env var via `worker-secrets` (shared ExternalSecret with `envFrom`)
4. **API** gets it via a separate `appinsights-secrets` secretRef (`optional: true`)

### Kubernetes Manifests

- `deploy/base/external-secret.yaml` — `appinsights-secrets` ExternalSecret
- `deploy/base/workers/worker-secrets.yaml` — adds `APPLICATIONINSIGHTS_CONNECTION_STRING` to shared worker secrets
- `deploy/base/api.yaml` — `appinsights-secrets` secretRef (optional)

### Infrastructure Dependency

Requires the App Insights resource and Key Vault secret to be provisioned by `scope-core-infra`. See the companion infrastructure changes in `growth-ecosystems/scope-core-infra`.

## Future: OpenTelemetry for AI

The OpenTelemetry `gen_ai.*` semantic conventions support tracking AI model interactions (token usage, model name, latency). Since Scope workers spawn agent subprocesses rather than making direct SDK calls, auto-instrumentation libraries like `@opentelemetry/instrumentation-openai` won't work.

The path forward is to create manual spans with `gen_ai` attributes after HAR parsing extracts token usage from captured HTTP traffic. This is tracked as future work.
