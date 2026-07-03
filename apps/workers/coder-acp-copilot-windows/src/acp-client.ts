// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Re-export ACP client from the Linux copilot worker package.
// The Windows worker shares the same ACP protocol logic; only the spawn shell
// option and subprocess env differ (handled in index.ts).
export { runACPSession, selectModel, buildCopilotBaseArgs } from "coder-acp-copilot/acp-client";
export type { ACPClientOptions, ACPSessionResult } from "coder-acp-copilot/acp-client";
