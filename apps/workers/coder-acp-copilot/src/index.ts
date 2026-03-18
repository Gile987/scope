// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CodingAgentQueueProcessor, WorkerProcessor, WorkerProcessorOptions, WorkerResult, QueueProcessorConfig, LogEvent, TokenManagerClient, DevProxyClient, parseHarFile, extractToolCalls } from "shared";
// NOTE: extractToolCalls is used for server-side logging only; tool calls are NOT stored in the DB
import { runACPSession } from "./acp-client.js";
import dotenv from "dotenv";

dotenv.config();

/**
 * Build the environment variables for the copilot subprocess.
 *
 * When DevProxy is active, configures proxy-related env vars so the subprocess
 * routes traffic through the DevProxy MITM proxy.
 * When DevProxy is disabled (or setup failed), strips proxy env vars and clears
 * NODE_EXTRA_CA_CERTS to prevent the subprocess from loading a non-existent cert.
 */
export function buildSubprocessEnv(
  githubToken: string,
  devProxyEnabled: boolean,
  currentNodeOptions?: string,
): Record<string, string> {
  return {
    GITHUB_TOKEN: githubToken,
    ...(devProxyEnabled ? {
      NODE_OPTIONS: [currentNodeOptions, "--use-env-proxy"].filter(Boolean).join(" "),
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    } : {
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      NODE_EXTRA_CA_CERTS: "",
    }),
  };
}

const WORKER_NAME = process.env.WORKER_NAME || "coder-acp-copilot";
const tokenClient = new TokenManagerClient();
const AGENT_VERSION = `copilot-${process.env.COPILOT_CLI_VERSION || "unknown"}`;

class CopilotProcessor implements WorkerProcessor {
  readonly workerName = WORKER_NAME;

  getAgentVersion(): string {
    return AGENT_VERSION;
  }

  getComponentVersions(): Record<string, string> {
    return {
      ...(process.env.COPILOT_CLI_VERSION ? { COPILOT_CLI_VERSION: process.env.COPILOT_CLI_VERSION } : {}),
    };
  }

  async processMessage(
    message: string,
    log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>,
    options?: WorkerProcessorOptions
  ): Promise<WorkerResult> {
    const mcpConfigs = options?.mcpServerConfigs ?? [];
    const skillConfigs = options?.skillConfigs ?? [];
    await log("info", "Starting Copilot ACP processor", {
      inputLength: message.length,
      model: options?.model,
      mcpServerCount: mcpConfigs.length,
      mcpServers: mcpConfigs.map((s) => ({ name: s.name, type: s.type, url: s.url })),
      skillCount: skillConfigs.length,
      skills: skillConfigs.map((s) => s.name),
    });
    
    // DevProxy integration — start recording if enabled
    let devProxy: DevProxyClient | null = null;
    let sslCertFile: string | undefined;
    if (DevProxyClient.isEnabled()) {
      devProxy = new DevProxyClient();
      try {
        await log("info", "DevProxy enabled — waiting for sidecar to be ready...");
        await devProxy.waitForReady();
        // Download CA cert if needed (for NODE_EXTRA_CA_CERTS)
        const certPath = process.env.NODE_EXTRA_CA_CERTS || "/tmp/dev-proxy-ca.crt";
        await devProxy.downloadCertificate(certPath);
        // Create combined CA bundle for native binaries (SSL_CERT_FILE)
        // The copilot binary is a native executable that doesn't use NODE_EXTRA_CA_CERTS
        const bundlePath = "/tmp/ca-bundle-combined.crt";
        sslCertFile = await devProxy.createCombinedCaBundle(certPath, bundlePath);
        await log("info", "DevProxy CA cert installed for native binaries", { sslCertFile });
        await devProxy.startRecording();
        await log("info", "DevProxy recording started");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await log("warn", `DevProxy setup failed, continuing without HAR capture: ${msg}`);
        devProxy = null;
      }
    }

    try {
      // Acquire token dynamically (env var fallback or Token Manager)
      const githubToken = await tokenClient.acquireToken("copilot-sdk");
      await log("info", "Acquired GITHUB_TOKEN", {
        preview: `${githubToken.substring(0, 7)}...(${githubToken.length} chars)`,
      });

      // Run ACP session with GitHub Copilot
      const args = ["--acp", "--yolo"];
      if (options?.model) {
        args.push("--model", options.model);
      }
      const result = await runACPSession(message, {
        command: "copilot",
        args,
        env: buildSubprocessEnv(githubToken, !!devProxy, process.env.NODE_OPTIONS),
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

      const response = result.response || `[${this.workerName}] No response from Copilot`;

      // DevProxy integration — stop recording and extract tool calls
      if (devProxy) {
        try {
          await devProxy.stopRecording();
          await log("info", "DevProxy recording stopped");

          const harFilePath = await devProxy.getLatestHarFile();
          if (harFilePath) {
            const har = await parseHarFile(harFilePath);
            const toolCalls = extractToolCalls(har);
            await log("info", `Extracted ${toolCalls.length} tool calls from HAR`, {
              toolCallCount: toolCalls.length,
              toolNames: toolCalls.map((tc) => tc.name),
            });
            return { response, harFilePath };
          } else {
            await log("warn", "No HAR file found after DevProxy recording");
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await log("warn", `DevProxy post-processing failed: ${msg}`);
        }
      }

      return { response };
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
    agentId: process.env.AGENT_ID || "coder-acp-copilot",
  };

  const processor = new CopilotProcessor();
  const queueProcessor = new CodingAgentQueueProcessor(config, processor);

  await queueProcessor.start();
}

main().catch((error) => {
  console.error("coder-acp-copilot failed to start:", error);
  process.exit(1);
});
