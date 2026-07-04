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
| 6 | Capture HAR files | ✅ DevProxy sidecar | ✅ DevProxy sidecar | ❌ Not implemented | ✅ AI Gateway (HAR plugin) |
| 7 | Capture video recordings | N/A (CLI, headless) | N/A (CLI, headless) | ✅ Playwright recording (setup + session) | ✅ ffmpeg X11 capture (`video-recorder.ts`) |
| 8 | Implement lifecycle hooks (`setup`/`teardown`) | — Not needed (stateless) | — Not needed (stateless) | ✅ VS Code process + browser lifecycle | ✅ Electron process + driver extension lifecycle |
| 9 | Report agent & component versions | ✅ `COPILOT_CLI_VERSION` | ✅ `CLAUDE_CODE_ACP_VERSION`, `CLAUDE_AGENT_SDK_VERSION` | ✅ `VSCODE_VERSION`, `COPILOT_CHAT_VERSION` | ✅ `VSCODE_VERSION`, `COPILOT_CHAT_VERSION` |
| 11 | Support MCP servers | ✅ Via ACP `mcpServers` | ✅ Via ACP `mcpServers` | ❌ Not implemented | ✅ Via `workbench.mcp.startServer` command |
| 12 | Support Skills | ✅ Filesystem discovery | ✅ Filesystem discovery | ✅ Filesystem discovery | ✅ Filesystem discovery |
| 13 | Have integration tests | ✅ `copilot-cli.integration.test.ts` | ❌ Unit tests only | ✅ `vscode-web.integration.test.ts` (Docker) | ✅ `vscode-electron.integration.test.ts` (Docker) |
| 14 | Support multi-turn conversations | ✅ Via queue processor | ✅ Via queue processor | ✅ Via `setup`/`teardown` + session reuse | ✅ Via `setup`/`teardown` + Electron reuse |
| 15 | Auto-approve agent permissions | ✅ `--yolo` + ACP session mode (always-on, not user-exposed) | ✅ ACP auto-approve / `bypassPermissions` | ✅ Playwright controls UI directly + `autoApprove` | ❌ Not implemented |
| 16 | Advertise per-worker agent `options` | ✅ `autopilot` (agent.yaml) | ❌ None advertised (autopilot no-op) | ✅ `autopilot` (agent.yaml) | ✅ `autopilot` (agent.yaml) |
| 17 | Honor native `autopilot` option | ✅ `--autopilot` flag when `options.autopilot === true` | ➖ No-op (headless ACP already autonomous) | ✅ `chat.autopilot.enabled` | ✅ `chat.autopilot.enabled` |
| 18 | Sandbox workspace filesystem access | N/A (agent manages own FS) | ✅ Path traversal protection in `ACPClientHandler` | N/A (browser-driven) | N/A (VS Code manages FS) |
| 19 | Persist auth state across iterations | N/A (stateless token) | N/A (stateless token) | ✅ Cookie state saved after each `processMessage()` | N/A (token minted once in `setup()`) |
| — | Token usage reporting | ✅ Extracted from HAR | ✅ Extracted from HAR | ❌ Not implemented | ✅ Extracted from HAR |

## Worker Details

| Property | Copilot CLI | Claude Code | VS Code Web | VS Code Electron |
|----------|-------------|-------------|-------------|------------------|
| **Agent interface** | ACP (subprocess) | ACP (subprocess) | Playwright (browser automation) | Driver extension (HTTP → `vscode.commands.executeCommand`) |
| **Token types** | GitHub PAT / OAuth | Anthropic API key / OAuth | GitHub OAuth cookie state | Scopeless GitHub OAuth (from VS Code's OAuth app) |
| **Agent version format** | `copilot-{COPILOT_CLI_VERSION}` | `claude-agent-acp-{ACP_VERSION}-sdk-{SDK_VERSION}` | `vscode-{VSCODE_VERSION}-copilot-{CHAT_VERSION}` | `vscode-electron-{VSCODE_VERSION}-copilot-{CHAT_VERSION}` |
| **Unit tests** | ✅ `subprocess-env.test.ts` | ✅ `acp-client.test.ts` | ✅ `chat-machine.test.ts` (16 tests), `chat-actions.test.ts` (4 tests), `index.test.ts` (3 tests) | ✅ `extension-driver-client.test.ts` (8 tests), `index.test.ts` (4 tests) |
| **Integration tests** | ✅ `copilot-cli.integration.test.ts` | ❌ | ✅ `vscode-web.integration.test.ts` (Docker-based, two-prompt flow) | ✅ `vscode-electron.integration.test.ts` (Docker-based, two-prompt flow) |
