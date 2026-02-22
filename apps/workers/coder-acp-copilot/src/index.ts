// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CodingAgentQueueProcessor, WorkerProcessor, WorkerProcessorOptions, QueueProcessorConfig, LogEvent, TokenManagerClient } from "shared";
import { runACPSession } from "./acp-client.js";
import dotenv from "dotenv";

dotenv.config();

const WORKER_NAME = process.env.WORKER_NAME || "coder-acp-copilot";
const tokenClient = new TokenManagerClient();

class CopilotProcessor implements WorkerProcessor {
  readonly workerName = WORKER_NAME;

  async processMessage(
    message: string,
    log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>,
    options?: WorkerProcessorOptions
  ): Promise<string> {
    await log("info", "Starting Copilot ACP processor", { inputLength: message.length, model: options?.model });
    
    try {
      // Acquire token dynamically (env var fallback or Token Manager)
      const githubToken = await tokenClient.acquireToken("copilot-sdk");
      await log("info", "Acquired GITHUB_TOKEN", {
        preview: `${githubToken.substring(0, 7)}...(${githubToken.length} chars)`,
      });

      // Run ACP session with GitHub Copilot
      const args = ["--acp"];
      if (options?.model) {
        args.push("--model", options.model);
      }
      const result = await runACPSession(message, {
        command: "copilot",
        args,
        env: {
          GITHUB_TOKEN: githubToken,
        },
        cwd: "/workspace",
        onLog: async (msg) => {
          await log("debug", msg);
        },
        mcpServers: options?.mcpServerConfigs,
      });

      await log("info", "Copilot processing complete", { 
        stopReason: result.stopReason,
        responseLength: result.response.length 
      });
      
      return result.response || `[${this.workerName}] No response from Copilot`;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await log("error", `Copilot processing failed: ${errorMessage}`);
      throw error;
    }
  }
}

async function main(): Promise<void> {
  // K8s: MONGO_CONNECTION_STRING from secret, STORAGE_CONNECTION_STRING from secret, QUEUE_NAME from deployment env
  const config: QueueProcessorConfig = {
    mongoUri: process.env.MONGO_CONNECTION_STRING || process.env.MONGO_URI || "mongodb://localhost:27017",
    mongoDatabase: process.env.MONGO_DATABASE || "requests-db",
    mongoCollection: process.env.MONGO_COLLECTION || "requests",
    storageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME || "",
    storageConnectionString: process.env.STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING,
    queueName: process.env.QUEUE_NAME || process.env.AZURE_STORAGE_QUEUE_NAME || "queue-coder-acp-copilot",
    batchSize: parseInt(process.env.BATCH_SIZE || "1", 10),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "1000", 10),
    redisHost: process.env.REDIS_HOST || "",
    redisPort: parseInt(process.env.REDIS_PORT || "6379", 10),
    redisPassword: process.env.REDIS_PASSWORD || "",
    apiBaseUrl: process.env.SCOPE_MT_API_URL,
  };

  const processor = new CopilotProcessor();
  const queueProcessor = new CodingAgentQueueProcessor(config, processor);

  await queueProcessor.start();
}

main().catch((error) => {
  console.error("coder-acp-copilot failed to start:", error);
  process.exit(1);
});
