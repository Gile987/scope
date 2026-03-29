# Worker Compliance Matrix

> **Status:** Current as of March 2026.

This document tracks which [coding worker requirements](worker-requirements.md) are met by each existing worker implementation.

## Compliance Matrix

| # | Requirement | Copilot CLI | Claude Code | VS Code Web | VS Code Electron |
|---|-------------|:-----------:|:-----------:|:-----------:|:----------------:|
| 1 | Implement `WorkerProcessor` | ✅ | ✅ | ✅ | ✅ |
| 2 | Consume messages via `processMessage` | ✅ | ✅ | ✅ | ✅ |
| 3 | Return `WorkerResult` | ✅ | ✅ | ✅ | ✅ |
| 4 | Publish structured logs | ✅ | ✅ | ✅ | ✅ |
| 6 | Capture HAR files | ✅ DevProxy sidecar | ✅ DevProxy sidecar | ❌ Not implemented | ✅ DevProxy sidecar |
| 7 | Capture video recordings | N/A (CLI, headless) | N/A (CLI, headless) | ✅ Playwright recording (setup + session) | ⚠️ Planned (ffmpeg X11 capture) |
| 8 | Implement lifecycle hooks (`setup`/`teardown`) | ❌ Not implemented | ❌ Not implemented | ✅ VS Code process + browser lifecycle | ✅ Electron process + driver extension lifecycle |
| 9 | Report agent & component versions | ✅ `COPILOT_CLI_VERSION` | ✅ `CLAUDE_CODE_ACP_VERSION`, `CLAUDE_AGENT_SDK_VERSION` | ✅ `VSCODE_VERSION`, `COPILOT_CHAT_VERSION` | ✅ `VSCODE_VERSION`, `COPILOT_CHAT_VERSION` |
| 11 | Support MCP servers | ✅ Via ACP `mcpServers` | ✅ Via ACP `mcpServers` | ❌ Not implemented | ✅ Via `workbench.mcp.startServer` command |
| 12 | Support Skills | ✅ Filesystem discovery | ✅ Filesystem discovery | ✅ Filesystem discovery | ✅ Filesystem discovery |
| 13 | Have integration tests | ✅ `copilot-cli.integration.test.ts` | ❌ Unit tests only | ✅ `vscode-web.integration.test.ts` (Docker) | ✅ `vscode-electron.integration.test.ts` (Docker) |
| 14 | Support multi-turn conversations | ✅ Via queue processor | ✅ Via queue processor | ✅ Via `setup`/`teardown` + session reuse | ✅ Via `setup`/`teardown` + Electron reuse |
| — | Token usage reporting | ✅ Extracted from HAR | ✅ Extracted from HAR | ❌ Not implemented | ✅ Extracted from HAR |

## Worker Details

| Property | Copilot CLI | Claude Code | VS Code Web | VS Code Electron |
|----------|-------------|-------------|-------------|------------------|
| **Agent interface** | ACP (subprocess) | ACP (subprocess) | Playwright (browser automation) | Driver extension (HTTP → `vscode.commands.executeCommand`) |
| **Token types** | GitHub PAT / OAuth | Anthropic API key / OAuth | GitHub OAuth cookie state | Scopeless GitHub OAuth (from VS Code's OAuth app) |
| **Agent version format** | `copilot-{COPILOT_CLI_VERSION}` | `claude-code-acp-{ACP_VERSION}-sdk-{SDK_VERSION}` | `vscode-{VSCODE_VERSION}-copilot-{CHAT_VERSION}` | `vscode-electron-{VSCODE_VERSION}-copilot-{CHAT_VERSION}` |
| **Unit tests** | ✅ `subprocess-env.test.ts` | ✅ `acp-client.test.ts` | ✅ `chat-machine.test.ts` (618 tests), `chat-actions.test.ts`, `index.test.ts` | ✅ `extension-driver-client.test.ts`, `index.test.ts` (12 tests) |
| **Integration tests** | ✅ `copilot-cli.integration.test.ts` | ❌ | ✅ `vscode-web.integration.test.ts` (Docker-based, two-prompt flow) | ✅ `vscode-electron.integration.test.ts` (Docker-based, two-prompt flow) |
