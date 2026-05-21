// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Check for new versions of @agentclientprotocol/claude-agent-acp and its
 * bundled @anthropic-ai/claude-agent-sdk dependency.
 *
 * Exports pure functions for fetching and comparing versions so they
 * can be unit-tested independently of the CLI entry point.
 *
 * Output conforms to the standardized CheckResult shape defined in
 * packages/version-checking.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import type { CheckResult, ComponentVersionInfo } from "version-checking";

export type { CheckResult, ComponentVersionInfo };

/**
 * Load pinned versions from a versions.env file.
 */
export function loadPinnedVersions(versionsEnvPath: string): {
  claudeCodeAcpVersion: string;
  claudeAgentSdkVersion: string;
} {
  const parsed = dotenv.parse(readFileSync(versionsEnvPath));
  const claudeCodeAcpVersion = parsed.CLAUDE_CODE_ACP_VERSION;
  const claudeAgentSdkVersion = parsed.CLAUDE_AGENT_SDK_VERSION;

  if (!claudeCodeAcpVersion || !claudeAgentSdkVersion) {
    throw new Error(
      `Missing required versions in ${versionsEnvPath}. ` +
        `Found CLAUDE_CODE_ACP_VERSION=${claudeCodeAcpVersion}, CLAUDE_AGENT_SDK_VERSION=${claudeAgentSdkVersion}`
    );
  }

  return { claudeCodeAcpVersion, claudeAgentSdkVersion };
}

interface NpmPackageResponse {
  version: string;
  dependencies?: Record<string, string>;
}

const NPM_REGISTRY = "https://registry.npmjs.org";

/**
 * Fetch metadata for a specific version (or dist-tag) of a package from npm.
 */
export async function fetchNpmPackageVersion(
  packageName: string,
  version: string,
): Promise<NpmPackageResponse> {
  const url = `${NPM_REGISTRY}/${packageName}/${version}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `npm registry returned ${response.status} for ${packageName}@${version}`
    );
  }
  return response.json() as Promise<NpmPackageResponse>;
}

/**
 * Fetch the latest version of @agentclientprotocol/claude-agent-acp and extract
 * both the ACP version and the bundled @anthropic-ai/claude-agent-sdk version.
 */
export async function fetchLatestVersions(): Promise<{
  claudeCodeAcpVersion: string;
  claudeAgentSdkVersion: string;
}> {
  const data = await fetchNpmPackageVersion(
    "@agentclientprotocol/claude-agent-acp",
    "latest",
  );

  const claudeAgentSdkVersion =
    data.dependencies?.["@anthropic-ai/claude-agent-sdk"];
  if (!claudeAgentSdkVersion) {
    throw new Error(
      "@anthropic-ai/claude-agent-sdk not found in dependencies of " +
        `@agentclientprotocol/claude-agent-acp@${data.version}`
    );
  }

  return {
    claudeCodeAcpVersion: data.version,
    claudeAgentSdkVersion,
  };
}

/**
 * Fetch the @anthropic-ai/claude-agent-sdk version bundled in a specific
 * version of @agentclientprotocol/claude-agent-acp.
 */
export async function fetchBundledSdkVersion(
  acpVersion: string,
): Promise<string> {
  const data = await fetchNpmPackageVersion(
    "@agentclientprotocol/claude-agent-acp",
    acpVersion,
  );

  const sdkVersion = data.dependencies?.["@anthropic-ai/claude-agent-sdk"];
  if (!sdkVersion) {
    throw new Error(
      "@anthropic-ai/claude-agent-sdk not found in dependencies of " +
        `@agentclientprotocol/claude-agent-acp@${acpVersion}`
    );
  }

  return sdkVersion;
}

const WORKER = "coder-acp-claude-code";
const VERSIONS_ENV_PATH = "apps/workers/coder-acp-claude-code/versions.env";

/**
 * Compare pinned versions against latest and return the result.
 */
export function compareVersions(
  current: { claudeCodeAcpVersion: string; claudeAgentSdkVersion: string },
  latest: { claudeCodeAcpVersion: string; claudeAgentSdkVersion: string },
): CheckResult {
  return {
    worker: WORKER,
    versionsEnvPath: VERSIONS_ENV_PATH,
    hasUpdates:
      current.claudeCodeAcpVersion !== latest.claudeCodeAcpVersion ||
      current.claudeAgentSdkVersion !== latest.claudeAgentSdkVersion,
    components: [
      {
        name: "claude-agent-acp",
        envVar: "CLAUDE_CODE_ACP_VERSION",
        current: current.claudeCodeAcpVersion,
        latest: latest.claudeCodeAcpVersion,
        link: "https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp",
      },
      {
        name: "claude-agent-sdk",
        envVar: "CLAUDE_AGENT_SDK_VERSION",
        current: current.claudeAgentSdkVersion,
        latest: latest.claudeAgentSdkVersion,
        link: "https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk",
      },
    ],
  };
}

/**
 * CLI entry point — run when executed directly via `tsx`.
 */
async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const versionsEnvPath = resolve(
    __dirname,
    "..",
    "..",
    "..",
    "workers",
    "coder-acp-claude-code",
    "versions.env",
  );

  const pinned = loadPinnedVersions(versionsEnvPath);
  console.error(
    `Current: claude-code-acp ${pinned.claudeCodeAcpVersion}, claude-agent-sdk ${pinned.claudeAgentSdkVersion}`
  );

  const latest = await fetchLatestVersions();
  console.error(
    `Latest:  claude-code-acp ${latest.claudeCodeAcpVersion}, claude-agent-sdk ${latest.claudeAgentSdkVersion}`
  );

  const result = compareVersions(pinned, latest);

  console.log(JSON.stringify(result, null, 2));

  if (result.hasUpdates) {
    console.error("Updates available");
    process.exit(1);
  } else {
    console.error("All versions up to date");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
