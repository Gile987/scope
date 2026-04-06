// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CodingAgentQueueProcessor, WorkerProcessor, WorkerProcessorOptions, WorkerResult, QueueProcessorConfig, LogEvent, WorkerLogFn, TokenManagerClient, DevProxyClient, createFreshWorkspace, cleanupWorkspaces } from "shared";
import { runACPSession } from "./acp-client.js";
import dotenv from "dotenv";

dotenv.config();

const WORKER_NAME = process.env.WORKER_NAME || "coder-acp-claude-code";
const tokenClient = new TokenManagerClient();
const AGENT_VERSION = `claude-code-acp-${process.env.CLAUDE_CODE_ACP_VERSION || "unknown"}-sdk-${process.env.CLAUDE_AGENT_SDK_VERSION || "unknown"}`;

class ClaudeCodeProcessor implements WorkerProcessor {
  readonly workerName = WORKER_NAME;
  workspacePath: string | undefined = undefined;

  getAgentVersion(): string {
    return AGENT_VERSION;
  }

  getComponentVersions(): Record<string, string> {
    return {
      ...(process.env.CLAUDE_CODE_ACP_VERSION ? { CLAUDE_CODE_ACP_VERSION: process.env.CLAUDE_CODE_ACP_VERSION } : {}),
      ...(process.env.CLAUDE_AGENT_SDK_VERSION ? { CLAUDE_AGENT_SDK_VERSION: process.env.CLAUDE_AGENT_SDK_VERSION } : {}),
    };
  }

  async setup(log: WorkerLogFn): Promise<void> {
    this.workspacePath = createFreshWorkspace();
    await log("info", "Fresh workspace created", { workspacePath: this.workspacePath });
  }

  async teardown(log: WorkerLogFn): Promise<void> {
    try {
      cleanupWorkspaces();
      await log("info", "Workspaces directory cleaned");
    } catch (error) {
      await log("warn", `Failed to clean workspaces directory: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.workspacePath = undefined;
  }

  async processMessage(
    message: string,
    log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>,
    options?: WorkerProcessorOptions
  ): Promise<WorkerResult> {
    const mcpConfigs = options?.mcpServerConfigs ?? [];
    const skillConfigs = options?.skillConfigs ?? [];
    await log("info", "Starting Claude Code ACP processor", {
      inputLength: message.length,
      model: options?.model,
      mcpServerCount: mcpConfigs.length,
      mcpServers: mcpConfigs.map((s) => ({ name: s.name, type: s.type, url: s.url })),
      skillCount: skillConfigs.length,
      skills: skillConfigs.map((s) => s.name),
    });

    // DevProxy integration — start recording if enabled
    let devProxy: DevProxyClient | null = null;
    if (DevProxyClient.isEnabled()) {
      devProxy = new DevProxyClient();
      try {
        await log("info", "DevProxy enabled — waiting for sidecar to be ready...");
        await devProxy.waitForReady();
        const certPath = process.env.NODE_EXTRA_CA_CERTS || "/tmp/dev-proxy-ca.crt";
        await devProxy.downloadCertificate(certPath);
        await log("info", "DevProxy CA cert installed", { certPath });
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
      // Prefer OAuth tokens over API keys
      const tokenResponse = await tokenClient.acquireTokenFull("claude-code-cli", "anthropic-oauth");
      const isOAuth = tokenResponse.keyType === "anthropic-oauth";
      const envVarName = isOAuth ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
      await log("info", `Acquired ${envVarName}`, {
        preview: `${tokenResponse.value.substring(0, 7)}...(${tokenResponse.value.length} chars)`,
        keyType: tokenResponse.keyType,
      });

      // Run ACP session with Claude Code
      const env: Record<string, string> = {
        [envVarName]: tokenResponse.value,
      };
      if (options?.model) {
        env.ANTHROPIC_MODEL = options.model;
      }
      // When DevProxy is active, ensure the subprocess routes through the proxy
      if (devProxy) {
        const existingNodeOptions = process.env.NODE_OPTIONS || "";
        env.NODE_OPTIONS = [existingNodeOptions, "--use-env-proxy"].filter(Boolean).join(" ");
        env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      } else if (!DevProxyClient.isEnabled()) {
        // DevProxy not configured — clear proxy vars so subprocess makes direct calls
        env.HTTP_PROXY = "";
        env.HTTPS_PROXY = "";
        env.http_proxy = "";
        env.https_proxy = "";
        env.NODE_EXTRA_CA_CERTS = "";
      }
      const result = await runACPSession(message, {
        command: "claude-code-acp",
        args: [],
        env,
        cwd: this.workspacePath,
        onLog: async (msg) => {
          await log("debug", msg);
        },
        mcpServers: options?.mcpServerConfigs,
      });

      await log("info", "Claude Code processing complete", { 
        stopReason: result.stopReason,
        responseLength: result.response.length 
      });

      const response = result.response || `[${this.workerName}] No response from Claude Code`;
      const { harFilePath, tokenUsage } = devProxy
        ? await devProxy.stopAndCollectHar(log)
        : { harFilePath: null, tokenUsage: undefined };
      return { response, ...(harFilePath && { harFilePath }), ...(tokenUsage && { tokenUsage }) };
    } catch (error) {
      if (devProxy) {
        const { harFilePath } = await devProxy.stopAndCollectHar(log);
        if (harFilePath) {
          (error as any).harFilePath = harFilePath;
        }
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      await log("error", `Claude Code processing failed: ${errorMessage}`);
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
    queueName: process.env.QUEUE_NAME || process.env.AZURE_STORAGE_QUEUE_NAME || "queue-coder-acp-claude-code",
    batchSize: parseInt(process.env.BATCH_SIZE || "1", 10),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "1000", 10),
    redisHost: process.env.REDIS_HOST || "",
    redisPort: parseInt(process.env.REDIS_PORT || "6379", 10),
    redisPassword: process.env.REDIS_PASSWORD || "",
    apiBaseUrl: process.env.SCOPE_MT_API_URL,
  };

  const processor = new ClaudeCodeProcessor();
  const queueProcessor = new CodingAgentQueueProcessor(config, processor);

  await queueProcessor.start();
}

main().catch((error) => {
  console.error("coder-acp-claude-code failed to start:", error);
  process.exit(1);
});
