#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import dotenv from "dotenv";
import { Command } from "commander";
import { configureHelp, generateOutputFormatsHelp, generateEnvVarsHelp } from "./utils/helpFormatter.js";
import { OUTPUT_FORMATS, ENV_VARS } from "./utils/shared.js";
import { registerRunCommands } from "./commands/run.js";
import { registerCriteriaCommands } from "./commands/criteria.js";
import { registerPromptFeatureCommands } from "./commands/prompt-feature.js";
import { registerReportCommands } from "./commands/report.js";
import { registerReportTemplateCommands } from "./commands/report-template.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerMcpCommands } from "./commands/mcp.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerExtensionCommands } from "./commands/extension.js";
import { registerInsightCommands } from "./commands/insight.js";
import { registerTaskPromptCommands } from "./commands/task-prompt.js";
import { registerProfileCommands } from "./commands/profile.js";

dotenv.config();

export const program = new Command();

program
  .name("scope-mt")
  .description("Scope — AI coding agent benchmarking CLI")
  .version("1.0.0")
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
  process.argv[1].endsWith('/cli/dist/index.js')
);
if (isDirectRun) {
  program.parse();
}
