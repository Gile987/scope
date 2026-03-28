# Worker Compliance Matrix

> **Status:** Current as of March 2026.

This document tracks which [coding worker requirements](worker-requirements.md) are met by each existing worker implementation.

## Compliance Matrix

| # | Requirement | Copilot CLI | Claude Code | VS Code Web |
|---|-------------|:-----------:|:-----------:|:-----------:|
| 1 | Implement `WorkerProcessor` | ✅ | ✅ | ✅ |
| 2 | Consume messages via `processMessage` | ✅ | ✅ | ✅ |
| 3 | Return `WorkerResult` | ✅ | ✅ | ✅ |
| 4 | Publish structured logs | ✅ | ✅ | ✅ |
| 6 | Capture HAR files | ✅ DevProxy sidecar | ✅ DevProxy sidecar | ❌ Not implemented |
| 7 | Capture video recordings | N/A (CLI, headless) | N/A (CLI, headless) | ✅ Playwright recording (setup + session) |
| 8 | Implement lifecycle hooks (`setup`/`teardown`) | ❌ Not implemented | ❌ Not implemented | ✅ VS Code process + browser lifecycle |
| 9 | Report agent & component versions | ✅ `COPILOT_CLI_VERSION` | ✅ `CLAUDE_CODE_ACP_VERSION`, `CLAUDE_AGENT_SDK_VERSION` | ✅ `VSCODE_VERSION`, `COPILOT_CHAT_VERSION` |
| 10 | Support model selection | ✅ `--model` flag | ✅ `ANTHROPIC_MODEL` env | ❌ Not implemented |
| 11 | Support MCP servers | ✅ Via ACP `mcpServers` | ✅ Via ACP `mcpServers` | ❌ Not implemented |
| 12 | Support Skills | ✅ Filesystem discovery | ✅ Filesystem discovery | ✅ Filesystem discovery |
| 13 | Have integration tests | ✅ `copilot-cli.integration.test.ts` | ❌ Unit tests only | ✅ `vscode-web.integration.test.ts` (Docker) |
| 14 | Support multi-turn conversations | ✅ Via queue processor | ✅ Via queue processor | ✅ Via `setup`/`teardown` + session reuse |
| — | Token usage reporting | ✅ Extracted from HAR | ✅ Extracted from HAR | ❌ Not implemented |

## Worker Details

| Property | Copilot CLI | Claude Code | VS Code Web |
|----------|-------------|-------------|-------------|
| **Agent interface** | ACP (subprocess) | ACP (subprocess) | Playwright (browser automation) |
| **Token types** | GitHub PAT / OAuth | Anthropic API key / OAuth | GitHub OAuth cookie state |
| **Agent version format** | `copilot-{COPILOT_CLI_VERSION}` | `claude-code-acp-{ACP_VERSION}-sdk-{SDK_VERSION}` | `vscode-{VSCODE_VERSION}-copilot-{CHAT_VERSION}` |
| **Unit tests** | ✅ `subprocess-env.test.ts` | ✅ `acp-client.test.ts` | ✅ `chat-machine.test.ts` (618 tests), `chat-actions.test.ts`, `index.test.ts` |
| **Integration tests** | ✅ `copilot-cli.integration.test.ts` | ❌ | ✅ `vscode-web.integration.test.ts` (Docker-based, two-prompt flow) |
