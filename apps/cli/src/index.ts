#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { configureHelp, generateOutputFormatsHelp, generateEnvVarsHelp } from "./utils/helpFormatter.js";
import { OUTPUT_FORMATS, ENV_VARS, applyApiPortFallback, getCliName } from "./utils/shared.js";
import { registerRunCommands } from "./commands/run.js";
import { registerCriteriaCommands } from "./commands/criteria.js";
import { registerPromptFeatureCommands } from "./commands/prompt-feature.js";

// Version is injected at build time by esbuild; falls back for dev mode
const CLI_VERSION = process.env.SCOPE_CLI_VERSION ?? "0.1.0-dev";
import { registerReportCommands } from "./commands/report.js";
import { registerReportTemplateCommands } from "./commands/report-template.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerMcpCommands } from "./commands/mcp.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerExtensionCommands } from "./commands/extension.js";
import { registerInsightCommands } from "./commands/insight.js";
import { registerTaskPromptCommands } from "./commands/task-prompt.js";
import { registerProfileCommands } from "./commands/profile.js";
import { checkForUpdates } from "./utils/update-check.js";

/**
 * Walk up from `start` looking for a `.env` file, stopping at the first hit
 * or at the filesystem root. Lets `pnpm cli ...` (which sets cwd to apps/cli)
 * still pick up the workspace-root `.env` produced by `worktree-env`, where
 * variables like SCOPE_API_PORT actually live.
 */
function findEnvFile(start: string): string | undefined {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const envPath = findEnvFile(process.cwd());
dotenv.config(envPath ? { path: envPath } : undefined);

// If SCOPE_API_URL is not already set but SCOPE_API_PORT is (e.g. when the API
// is running locally on a non-default port via docker-compose), derive a
// default SCOPE_API_URL of http://localhost:$SCOPE_API_PORT. Must run before
// any command module captures `process.env.SCOPE_API_URL` as its option
// default.
applyApiPortFallback();

export const program = new Command();

program
  .name(getCliName())
  .description("Scope — AI coding agent benchmarking CLI")
  .version(CLI_VERSION)
  .action(() => {
    program.help();
  })
  .addHelpText('after', generateOutputFormatsHelp(OUTPUT_FORMATS))
  .addHelpText('after', generateEnvVarsHelp(ENV_VARS));

configureHelp(program);

// Register all command groups
registerRunCommands(program);
registerCriteriaCommands(program);
registerPromptFeatureCommands(program);
registerReportCommands(program);
registerReportTemplateCommands(program);
registerAgentCommands(program);
registerMcpCommands(program);
registerSkillCommands(program);
registerExtensionCommands(program);
registerInsightCommands(program);
registerTaskPromptCommands(program);
registerProfileCommands(program);

// Only parse when run directly (not when imported by tests)
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('/cli/src/index.ts') ||
  process.argv[1].endsWith('/cli/dist/index.js') ||
  process.argv[1].endsWith('/scope.mjs') ||
  process.argv[1].endsWith('/dist/scope.mjs')
);
if (isDirectRun) {
  checkForUpdates(CLI_VERSION);
  program.parse();
}
