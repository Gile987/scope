// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Check for new versions of the @github/copilot CLI package.
 *
 * Exports pure functions for fetching and comparing versions so they
 * can be unit-tested independently of the CLI entry point.
 *
 * Output conforms to the standardized CheckResult shape defined in
 * packages/shared/src/version-check.ts.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

/** Mirrors ComponentVersionInfo from packages/shared/src/version-check.ts */
export interface ComponentVersionInfo {
  name: string;
  envVar: string;
  current: string;
  latest: string;
  link: string;
}

/** Mirrors CheckResult from packages/shared/src/version-check.ts */
export interface CheckResult {
  worker: string;
  versionsEnvPath: string;
  hasUpdates: boolean;
  components: ComponentVersionInfo[];
}

/**
 * Load pinned versions from a versions.env file.
 */
export function loadPinnedVersions(versionsEnvPath: string): {
  copilotCliVersion: string;
} {
  const parsed = dotenv.parse(readFileSync(versionsEnvPath));
  const copilotCliVersion = parsed.COPILOT_CLI_VERSION;

  if (!copilotCliVersion) {
    throw new Error(
      `Missing required version in ${versionsEnvPath}. ` +
        `Found COPILOT_CLI_VERSION=${copilotCliVersion}`
    );
  }

  return { copilotCliVersion };
}

/**
 * Fetch the latest stable version of @github/copilot from the npm registry.
 */
export async function fetchLatestCopilotCliVersion(): Promise<string> {
  const response = await fetch(
    "https://registry.npmjs.org/@github/copilot"
  );
  if (!response.ok) {
    throw new Error(`npm registry API returned ${response.status}`);
  }
  const data = await response.json();
  const latest = data?.["dist-tags"]?.latest;
  if (!latest) {
    throw new Error(
      "npm registry response missing dist-tags.latest for @github/copilot"
    );
  }
  return latest;
}

const WORKER = "coder-acp-copilot";
const VERSIONS_ENV_PATH = "apps/workers/coder-acp-copilot/versions.env";

/**
 * Compare pinned version against latest and return the result.
 */
export function compareVersions(
  current: { copilotCliVersion: string },
  latest: { copilotCliVersion: string }
): CheckResult {
  return {
    worker: WORKER,
    versionsEnvPath: VERSIONS_ENV_PATH,
    hasUpdates: current.copilotCliVersion !== latest.copilotCliVersion,
    components: [
      {
        name: "@github/copilot",
        envVar: "COPILOT_CLI_VERSION",
        current: current.copilotCliVersion,
        latest: latest.copilotCliVersion,
        link: "https://www.npmjs.com/package/@github/copilot",
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
    "coder-acp-copilot",
    "versions.env"
  );

  const pinned = loadPinnedVersions(versionsEnvPath);
  console.error(`Current: @github/copilot ${pinned.copilotCliVersion}`);

  const latestCopilotCli = await fetchLatestCopilotCliVersion();
  console.error(`Latest:  @github/copilot ${latestCopilotCli}`);

  const result = compareVersions(pinned, {
    copilotCliVersion: latestCopilotCli,
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.hasUpdates) {
    console.error("Updates available");
    process.exit(1);
  } else {
    console.error("Already up to date");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
