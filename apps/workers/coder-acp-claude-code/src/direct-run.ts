// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { runDirect, WorkerProcessor, LogEvent } from "shared";
import { runACPSession } from "./acp-client.js";
import dotenv from "dotenv";

dotenv.config();

const WORKER_NAME = process.env.WORKER_NAME || "coder-acp-claude-code";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

class ClaudeCodeProcessor implements WorkerProcessor {
  readonly workerName = WORKER_NAME;

  async processMessage(
    message: string,
    log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<string> {
    await log("info", "Starting Claude Code ACP processor", { inputLength: message.length });

    try {
      const result = await runACPSession(message, {
        command: "claude-code-acp",
        args: [],
        env: { ANTHROPIC_API_KEY },
        cwd: "/workspace",
        onLog: async (msg) => {
          await log("debug", msg);
        },
      });

      await log("info", "Claude Code processing complete", {
        stopReason: result.stopReason,
        responseLength: result.response.length,
      });

      return result.response || `[${this.workerName}] No response from Claude Code`;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await log("error", `Claude Code processing failed: ${errorMessage}`);
      throw error;
    }
  }
}

runDirect(new ClaudeCodeProcessor()).catch((error) => {
  console.error("direct-run failed:", error);
  process.exit(1);
});
