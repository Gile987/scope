#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import dotenv from "dotenv";
import { Command } from "commander";
import EventSource from "eventsource";
import { execSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { stringify as yamlStringify } from "yaml";
import React from "react";
import { render } from "ink";
import { DemoApp } from "./components/DemoApp.js";
import { resolveScenarioAndPersona } from "./config-loader.js";
import { configureHelp } from "./utils/helpFormatter.js";
import { colorLevel, dimTimestamp, errorText, successText, label, value, banner, warnBanner, criterionIcon, styleText } from "./utils/style.js";

dotenv.config();

function printFollowUpCommands(id: string): void {
  console.log(`\n${label('Run ID:')} ${value(id)}`);
  console.log(`\n${label('Next steps:')}`);
  console.log(`  ${dimTimestamp('Check status:')}  pnpm cli run status -i ${id}`);
  console.log(`  ${dimTimestamp('Stream logs:')}   pnpm cli run logs -i ${id}`);
  console.log(`  ${dimTimestamp('Download:')}      pnpm cli run download -i ${id}`);
  console.log(`  ${dimTimestamp('List all runs:')} pnpm cli run list`);
}

const program = new Command();

const DEFAULT_WORKERS = [
  "coder-acp-claude-code",
  "coder-acp-copilot",
  "coder-vscode-web",
];

program
  .name("scope-mt")
  .description("Scope MT — AI coding agent benchmarking CLI")
  .version("1.0.0")
  .action(() => {
    program.help();
  });

configureHelp(program);

const run = program
  .command("run")
  .description("Submit, monitor, and manage benchmark runs")
  .action(() => {
    run.help();
  });

configureHelp(run);

run
  .command("submit")
  .description("Submit a request to a worker and stream logs")
  .option("-s, --scenario <path>", "Path to scenario YAML file (provides task + criteria)")
  .option("-p, --persona <path>", "Path to persona YAML file (provides judge personality)")
  .option("-t, --traits <path>", "Path to traits.yaml (default: config/traits.yaml next to persona)")
  .option("-m, --message <message>", "Message/task to process (overrides scenario task)")
  .option("-w, --worker <worker>", "Worker to use (coder-acp-claude-code, coder-acp-copilot, coder-vscode-web)", "coder-acp-copilot")
  .option("-c, --criteria <criteria...>", "Evaluation criteria (overrides scenario criteria)")
  .option("--max-iterations <number>", "Max judge iterations for multi-turn mode", parseInt)
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("--no-stream", "Don't stream logs, just submit")
  .action(async (options) => {
    const { scenario, persona, traits, worker, url, stream, maxIterations } = options;

    try {
      // Resolve scenario + persona YAML if provided
      let message = options.message;
      let criteria = options.criteria;
      let scenarioVersion: 'v1' | 'v2' | undefined;
      let personaInstructions: string | undefined;
      let personaObj: Record<string, unknown> | undefined;

      if (scenario) {
        const resolved = resolveScenarioAndPersona(scenario, persona, traits);
        // Scenario provides task and criteria (CLI flags override)
        if (!message) message = resolved.task;
        if (!criteria || criteria.length === 0) criteria = resolved.criteria;
        scenarioVersion = resolved.version;
        personaInstructions = resolved.personaInstructions;
        personaObj = resolved.persona;

        console.log(`${label('Scenario:')} ${value(scenario)} (version: ${value(scenarioVersion || 'v1')})`);
        if (persona) console.log(`${label('Persona:')} ${value(persona)}`);
        console.log(`${label('Task:')} ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);
        console.log(`${label('Criteria:')} ${value(String(criteria.length))} items`);
        console.log();
      }

      if (!message) {
        console.error(errorText("Error: --message or --scenario is required"));
        process.exit(1);
      }

      // Build request body — scenario is the source of truth
      const body: Record<string, unknown> = {
        scenario: {
          ...(scenarioVersion ? { version: scenarioVersion } : {}),
          task: message,
          criteria: criteria || [],
        },
      };
      if (maxIterations) {
        body.maxIterations = maxIterations;
      }
      if (personaInstructions) {
        body.personaInstructions = personaInstructions;
      }
      if (personaObj) {
        body.persona = personaObj;
      }

      const response = await fetch(`${url}/api/v1/requests?worker=${worker}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error);
        process.exit(1);
      }

      const result = await response.json();
      console.log(`${successText('Request submitted:')} ${value(result.id)}`);
      console.log(`${label('Worker:')} ${value(result.workerType)}`);
      console.log(`${label('Mode:')} ${value(result.mode || 'one-shot')}`);
      console.log(`${label('Status:')} ${value(result.status)}`);

      if (!stream) {
        printFollowUpCommands(result.id);
        return;
      }

      // Stream logs
      console.log(`\n${banner('--- Streaming logs ---')}\n`);

      const eventSource = new EventSource(`${url}/api/v1/requests/${result.id}/logs`);

      eventSource.onmessage = (event) => {
        try {
          const log = JSON.parse(event.data);
          const timestamp = new Date(log.timestamp).toLocaleTimeString();
          const src = log.source ? `[${log.source}] ` : '';
          const iter = log.data?.iteration != null ? `[iter ${log.data.iteration}] ` : '';

          // Detect special criterion/DAG log events and render them with status icons
          if (log.data?.type === "criterion_result") {
            const d = log.data;
            const icon = criterionIcon(d.evaluated, d.passed);
            console.log(`[${dimTimestamp(timestamp)}] [${colorLevel(log.level)}] ${src}${iter} ${icon} ${d.criterionId}`);
            if (d.feedback && !d.passed && d.evaluated) {
              console.log(`           ${styleText('gray', d.feedback.substring(0, 120))}`);
            }
            return;
          }

          if (log.data?.type === "criteria_dag_status") {
            console.log(`[${dimTimestamp(timestamp)}] [${colorLevel(log.level)}] ${src}${iter}${log.message}`);
            const results = log.data.results as Array<{ criterionId: string; passed: boolean; evaluated: boolean; feedback: string }>;
            if (results) {
              for (const r of results) {
                const icon = criterionIcon(r.evaluated, r.passed);
                console.log(`              ${icon} ${r.criterionId}`);
              }
            }
            return;
          }

          console.log(`[${dimTimestamp(timestamp)}] [${colorLevel(log.level)}] ${src}${iter}${log.message}`);
          if (log.data) {
            // Filter out keys already rendered in the log line prefix
            const { iteration: _iter, type: _type, ...rest } = log.data;
            if (Object.keys(rest).length > 0) {
              const dataStr = JSON.stringify(rest, null, 2)
                .split("\n")
                .map((line) => `           ${line}`)
                .join("\n");
              console.log(dataStr);
            }
          }
        } catch {
          console.log(event.data);
        }
      };

      eventSource.addEventListener("done", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data);
          console.log(`\n${successText(`--- Processing ${data.status} ---`)}`);
        } catch {
          console.log(`\n${successText('--- Done ---')}`);
        }
        printFollowUpCommands(result.id);
        eventSource.close();
        process.exit(0);
      });

      eventSource.addEventListener("error", () => {
        console.error(`\n${errorText('--- Connection error ---')}`);
        eventSource.close();
        process.exit(1);
      });

      eventSource.addEventListener("timeout", () => {
        console.log(`\n${warnBanner('--- Stream timeout ---')}`);
        eventSource.close();
        process.exit(0);
      });

    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

run
  .command("status")
  .description("Get status of a request")
  .requiredOption("-i, --id <id>", "Request ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    const { id } = options;
    try {
      const response = await fetch(`${options.url}/api/v1/requests/${id}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error);
        process.exit(1);
      }

      const request = await response.json();
      console.log(`${label('ID:')} ${value(request.id)}`);
      console.log(`${label('Worker:')} ${value(request.workerType)}`);
      console.log(`${label('Status:')} ${value(request.status)}`);
      if (request.mode) console.log(`${label('Mode:')} ${value(request.mode)}`);
      if (request.createdAt) console.log(`${label('Created:')} ${value(request.createdAt)}`);
      if (request.completedAt) console.log(`${label('Completed:')} ${value(request.completedAt)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

run
  .command("logs")
  .description("Stream logs for a request")
  .requiredOption("-i, --id <id>", "Request ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("--from-start", "Include historical logs from start")
  .action(async (options) => {
    const { id } = options;
    const url = options.fromStart
      ? `${options.url}/api/v1/requests/${id}/logs?fromStart=true`
      : `${options.url}/api/v1/requests/${id}/logs`;

    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const log = JSON.parse(event.data);
        const timestamp = new Date(log.timestamp).toLocaleTimeString();
        const src = log.source ? `[${log.source}] ` : '';
        const iter = log.data?.iteration != null ? `[iter ${log.data.iteration}] ` : '';

        if (log.data?.type === "criterion_result") {
          const d = log.data;
          const icon = criterionIcon(d.evaluated, d.passed);
          console.log(`[${dimTimestamp(timestamp)}] [${colorLevel(log.level)}] ${src}${iter} ${icon} ${d.criterionId}`);
          return;
        }

        if (log.data?.type === "criteria_dag_status") {
          console.log(`[${dimTimestamp(timestamp)}] [${colorLevel(log.level)}] ${src}${iter}${log.message}`);
          const results = log.data.results as Array<{ criterionId: string; passed: boolean; evaluated: boolean }>;
          if (results) {
            for (const r of results) {
              const icon = criterionIcon(r.evaluated, r.passed);
              console.log(`              ${icon} ${r.criterionId}`);
            }
          }
          return;
        }

        console.log(`[${dimTimestamp(timestamp)}] [${colorLevel(log.level)}] ${src}${iter}${log.message}`);
      } catch {
        console.log(event.data);
      }
    };

    eventSource.addEventListener("done", () => {
      console.log(`\n${successText('--- Done ---')}`);
      eventSource.close();
      process.exit(0);
    });

    eventSource.addEventListener("error", () => {
      console.error(`\n${errorText('--- Connection error ---')}`);
      eventSource.close();
      process.exit(1);
    });
  });

run
  .command("list")
  .description("List all requests")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("-w, --worker <worker>", "Filter by worker")
  .action(async (options) => {
    try {
      let url = `${options.url}/api/v1/requests`;
      if (options.worker) {
        url += `?worker=${options.worker}`;
      }

      const response = await fetch(url);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error);
        process.exit(1);
      }

      const requests = await response.json();
      if (Array.isArray(requests) && requests.length === 0) {
        console.log(warnBanner('No requests found.'));
        return;
      }
      if (Array.isArray(requests)) {
        console.log(label(`Found ${requests.length} request(s):\n`));
        for (const req of requests) {
          const status = req.status === 'completed' ? successText(req.status)
            : req.status === 'failed' ? errorText(req.status)
            : value(req.status ?? 'unknown');
          console.log(`  ${value(req.id ?? '(no id)')}  ${label('worker=')}${req.workerType ?? 'unknown'}  ${label('status=')}${status}`);
        }
      } else {
        console.log(JSON.stringify(requests, null, 2));
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

run
  .command("demo")
  .description("Run concurrent requests to all coders with a live TUI dashboard")
  .requiredOption("-m, --message <message>", "Message/prompt to send to all coders")
  .option("-c, --count <count>", "Number of requests to send to each coder", "1")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("-w, --workers <workers>", "Comma-separated list of workers", DEFAULT_WORKERS.join(","))
  .action((options) => {
    const { message, count, url, workers: workersStr } = options;
    const workersList = workersStr.split(",").map((w: string) => w.trim());
    const countNum = parseInt(count, 10);

    if (isNaN(countNum) || countNum < 1) {
      console.error(errorText("Error: count must be a positive integer"));
      process.exit(1);
    }

    console.clear();
    const { waitUntilExit } = render(
      React.createElement(DemoApp, {
        apiUrl: url,
        message,
        count: countNum,
        workers: workersList,
      })
    );
    waitUntilExit().catch(() => {});
  });

run
  .command("download")
  .description("Download all artifacts of a run (workspaces + run document)")
  .requiredOption("-i, --id <id>", "Request ID")
  .option("-o, --output <path>", "Output file path (default: <id>.tar.gz)")
  .option("-e, --extract", "Extract the archive after downloading")
  .option("-d, --dir <path>", "Extraction directory (implies --extract)")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    const { id, url } = options;
    const shouldExtract = options.extract || !!options.dir;
    const downloadDir = process.env.SCOPE_MT_DOWNLOAD_OUTPUT_DIR;
    const defaultFile = downloadDir ? join(downloadDir, `${id}.tar.gz`) : `${id}.tar.gz`;
    const outputFile = options.output || defaultFile;

    try {
      // Step 1: Fetch request document
      console.log(`${label('Fetching run')} ${value(id)}...`);
      const response = await fetch(`${url}/api/v1/requests/${id}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error);
        process.exit(1);
      }
      const request = await response.json();

      if (!request.turns || request.turns.length === 0) {
        console.error(errorText("Error: No iterations found for this run"));
        process.exit(1);
      }

      console.log(`${label('Status:')} ${value(request.status)}`);
      console.log(`${label('Worker:')} ${value(request.workerType)}`);
      console.log(`${label('Iterations:')} ${value(String(request.turns.length))}`);
      console.log();

      // Step 2: Create temp staging directory
      const stageDir = mkdtempSync(join(tmpdir(), `scope-mt-${id.substring(0, 8)}-`));
      const runDir = join(stageDir, id);
      mkdirSync(runDir, { recursive: true });

      try {
        // Step 3: Write run document as YAML (exclude bulky logs array)
        const { logs: _logs, ...runDoc } = request;
        writeFileSync(join(runDir, "run.yaml"), yamlStringify(runDoc, { lineWidth: 120 }));
        console.log(`  ${successText('+')} run.yaml`);

        // Step 4: Download each iteration snapshot
        for (const turn of request.turns) {
          const iter = turn.iteration;
          const iterDir = join(runDir, `iteration-${iter}`);
          mkdirSync(iterDir, { recursive: true });

          process.stdout.write(`  ${label(`iteration-${iter}/`)} downloading...`);

          const snapshotResp = await fetch(`${url}/api/v1/requests/${id}/snapshots/${iter}`);
          if (!snapshotResp.ok || !snapshotResp.body) {
            console.log(` ${errorText('FAILED')}`);
            console.error(`    ${errorText(`Could not download iteration ${iter}: ${snapshotResp.statusText}`)}`);
            continue;
          }

          // Save tar.gz to temp then extract into iteration dir
          const archivePath = join(stageDir, `iter-${iter}.tar.gz`);
          const fileStream = createWriteStream(archivePath);
          await pipeline(Readable.fromWeb(snapshotResp.body as any), fileStream);
          execSync(`tar xzf "${archivePath}" -C "${iterDir}"`, { stdio: "pipe" });

          const verdict = turn.passed ? successText('● pass') : errorText('✗ fail');
          process.stdout.write(`\r  ${label(`iteration-${iter}/`)} ${successText('downloaded')}  ${verdict}\n`);
        }

        // Step 5: Create the final tar.gz archive
        console.log();
        const outputPath = resolve(outputFile);
        mkdirSync(dirname(outputPath), { recursive: true });
        execSync(`tar czf "${outputPath}" -C "${stageDir}" "${id}"`, { stdio: "pipe" });
        console.log(`${successText('Archive:')} ${value(outputPath)}`);

        // Step 6: Optionally extract
        if (shouldExtract) {
          const extractDir = options.dir || ".";
          execSync(`tar xzf "${outputPath}" -C "${extractDir}"`, { stdio: "pipe" });
          console.log(`${successText('Extracted to:')} ${value(join(extractDir, id))}`);
        }

      } finally {
        // Cleanup staging directory
        rmSync(stageDir, { recursive: true, force: true });
      }

    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
