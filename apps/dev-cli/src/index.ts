#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import dotenv from "dotenv";
import { Command } from "commander";
import { workerRunCommand } from "./commands/worker-run.js";
import { configureHelp } from "./utils/helpFormatter.js";

dotenv.config();

const program = new Command();

program
  .name("dev-cli")
  .description("Scope MT development tools — run workers locally via Docker")
  .version("1.0.0")
  .action(() => {
    program.help();
  });

configureHelp(program);

const worker = program
  .command("worker")
  .description("Worker management commands")
  .action(() => {
    worker.help();
  });

configureHelp(worker);

worker.addCommand(workerRunCommand());

program.parse(process.argv);
