// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { runDirect, WorkerProcessor, LogEvent } from "shared";
import { runACPSession } from "./acp-client.js";
import dotenv from "dotenv";

dotenv.config();

const WORKER_NAME = process.env.WORKER_NAME || "coder-acp-copilot";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

class CopilotProcessor implements WorkerProcessor {
  readonly workerName = WORKER_NAME;

  async processMessage(
    message: string,
    log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>
  ): Promise<string> {
    await log("info", "Starting Copilot ACP processor", { inputLength: message.length });

    try {
      const result = await runACPSession(message, {
        command: "copilot",
        args: ["--acp"],
        env: { GITHUB_TOKEN },
        cwd: "/workspace",
        onLog: async (msg) => {
          await log("debug", msg);
        },
      });

      await log("info", "Copilot processing complete", {
        stopReason: result.stopReason,
        responseLength: result.response.length,
      });

      return result.response || `[${this.workerName}] No response from Copilot`;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await log("error", `Copilot processing failed: ${errorMessage}`);
      throw error;
    }
  }
}

runDirect(new CopilotProcessor()).catch((error) => {
  console.error("direct-run failed:", error);
  process.exit(1);
});
