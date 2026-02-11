#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import dotenv from "dotenv";
import { Command } from "commander";
import EventSource from "eventsource";
import { execSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream, rmSync, readFileSync, readdirSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname, basename, extname } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { parse as yamlParse, parseAllDocuments, stringify as yamlStringify } from "yaml";
import React from "react";
import { render } from "ink";
import { DemoApp } from "./components/DemoApp.js";
import { resolveScenarioAndPersona } from "./config-loader.js";
import { configureHelp } from "./utils/helpFormatter.js";
import { colorLevel, dimTimestamp, errorText, successText, label, value, banner, warnBanner, criterionIcon, styleText } from "./utils/style.js";

dotenv.config();

/** Strip trailing slashes from a URL to avoid double-slash issues when appending paths */
const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

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

      const response = await fetch(`${normalizeUrl(url)}/api/v1/requests?worker=${worker}`, {
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

      const eventSource = new EventSource(`${normalizeUrl(url)}/api/v1/requests/${result.id}/logs`);

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
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/requests/${id}`);

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
      ? `${normalizeUrl(options.url)}/api/v1/requests/${id}/logs?fromStart=true`
      : `${normalizeUrl(options.url)}/api/v1/requests/${id}/logs`;

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
  .option("--include-deleted", "Include soft-deleted runs")
  .action(async (options) => {
    try {
      let url = `${normalizeUrl(options.url)}/api/v1/requests`;
      const params = new URLSearchParams();
      if (options.worker) {
        params.set("worker", options.worker);
      }
      if (options.includeDeleted) {
        params.set("includeDeleted", "true");
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;

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
  .command("delete")
  .description("Soft-delete a run (can still be listed with --include-deleted)")
  .requiredOption("-i, --id <id>", "Request ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    const { id, url } = options;
    try {
      const response = await fetch(`${normalizeUrl(url)}/api/v1/requests/${id}`, { method: "DELETE" });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      console.log(`${successText('Deleted run')} ${value(id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
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
      const response = await fetch(`${normalizeUrl(url)}/api/v1/requests/${id}`);
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

          const snapshotResp = await fetch(`${normalizeUrl(url)}/api/v1/requests/${id}/snapshots/${iter}`);
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

          process.stdout.write(`\r  ${label(`iteration-${iter}/`)} ${successText('downloaded')}\n`);
        }

        // Step 5: Create the final tar.gz archive
        console.log();
        const outputPath = resolve(outputFile);
        mkdirSync(dirname(outputPath), { recursive: true });
        execSync(`tar czf "${outputPath}" -C "${stageDir}" "${id}"`, { stdio: "pipe" });
        console.log(`${successText('Archive:')} ${value(outputPath)}`);

        // Step 6: Optionally extract
        if (shouldExtract) {
          const extractDir = options.dir || downloadDir || ".";
          mkdirSync(extractDir, { recursive: true });
          execSync(`tar xzf "${outputPath}" -C "${extractDir}"`, { stdio: "pipe" });
          rmSync(outputPath, { force: true });
          console.log(`${successText('Extracted to:')} ${value(resolve(extractDir, id))}`);
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

// ─── Criteria management ─────────────────────────────────────────────────────

const criteria = program
  .command("criteria")
  .description("Manage evaluation criteria (CRUD, import, graph)")
  .action(() => {
    criteria.help();
  });

configureHelp(criteria);

criteria
  .command("list")
  .description("List all criteria")
  .option("-q, --query <search>", "Filter by ID or prompt text")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const params = new URLSearchParams();
      if (options.query) params.set("q", options.query);
      const qs = params.toString();
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/criteria${qs ? `?${qs}` : ""}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const items = await response.json() as Array<{ id: string; prompt: string; dependsOn?: string[] }>;
      if (items.length === 0) {
        console.log(warnBanner("No criteria found."));
        return;
      }

      console.log(label(`Found ${items.length} criteria:\n`));

      // Table header
      const idW = Math.max(24, ...items.map(c => c.id.length)) + 2;
      console.log(`  ${styleText('bold', 'ID'.padEnd(idW))}${styleText('bold', 'Deps'.padEnd(6))}${'Prompt'}`);
      console.log(`  ${'─'.repeat(idW)}${'─'.repeat(6)}${'─'.repeat(50)}`);

      for (const c of items) {
        const deps = (c.dependsOn ?? []).length;
        const prompt = c.prompt.replace(/\n/g, ' ').substring(0, 60);
        console.log(`  ${value(c.id.padEnd(idW))}${String(deps).padEnd(6)}${dimTimestamp(prompt)}${c.prompt.length > 60 ? '…' : ''}`);
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

criteria
  .command("get")
  .description("Get details of a single criterion")
  .requiredOption("-i, --id <id>", "Criterion ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/criteria/${options.id}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const c = await response.json() as {
        id: string; prompt: string; dependsOn?: string[];
        dependents: string[]; createdAt: string; updatedAt?: string;
      };

      console.log(`${label('ID:')}        ${value(c.id)}`);
      console.log(`${label('Prompt:')}`);
      for (const line of c.prompt.trim().split('\n')) {
        console.log(`  ${line}`);
      }
      if ((c.dependsOn ?? []).length > 0) {
        console.log(`${label('Depends on:')} ${c.dependsOn!.map(d => value(d)).join(', ')}`);
      } else {
        console.log(`${label('Depends on:')} ${dimTimestamp('(none — root criterion)')}`);
      }
      if (c.dependents.length > 0) {
        console.log(`${label('Dependents:')} ${c.dependents.map(d => value(d)).join(', ')}`);
      }
      console.log(`${label('Created:')}   ${value(c.createdAt)}`);
      if (c.updatedAt) console.log(`${label('Updated:')}   ${value(c.updatedAt)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

criteria
  .command("create")
  .description("Create a new criterion")
  .requiredOption("--id <id>", "Criterion ID (lowercase snake_case)")
  .requiredOption("--prompt <prompt>", "Evaluation prompt for the judge")
  .option("-d, --depends-on <ids...>", "IDs of parent criteria")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {
        id: options.id,
        prompt: options.prompt,
      };
      if (options.dependsOn && options.dependsOn.length > 0) {
        body.dependsOn = options.dependsOn;
      }

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/criteria`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const created = await response.json();
      console.log(`${successText('Created criterion')} ${value(created.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

criteria
  .command("update")
  .description("Update an existing criterion")
  .requiredOption("-i, --id <id>", "Criterion ID")
  .option("--prompt <prompt>", "New evaluation prompt")
  .option("-d, --depends-on <ids...>", "New parent criteria IDs (replaces all)")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {};
      if (options.prompt !== undefined) body.prompt = options.prompt;
      if (options.dependsOn !== undefined) body.dependsOn = options.dependsOn;

      if (Object.keys(body).length === 0) {
        console.error(errorText("Error: provide --prompt and/or --depends-on"));
        process.exit(1);
      }

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/criteria/${options.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      console.log(`${successText('Updated criterion')} ${value(options.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

criteria
  .command("delete")
  .description("Delete a criterion (soft-delete; fails if other criteria depend on it)")
  .requiredOption("-i, --id <id>", "Criterion ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/criteria/${options.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        if (error.dependents) {
          console.error(errorText(`Cannot delete '${options.id}': depended on by ${error.dependents.join(', ')}`));
        } else {
          console.error(errorText("Error:"), error.error || JSON.stringify(error));
        }
        process.exit(1);
      }

      console.log(`${successText('Deleted criterion')} ${value(options.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

criteria
  .command("graph")
  .description("Display the criteria dependency graph as ASCII")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/criteria/graph`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const graph = await response.json() as {
        nodes: Array<{ id: string; prompt: string; dependsOn: string[] }>;
        edges: Array<{ from: string; to: string }>;
      };

      if (graph.nodes.length === 0) {
        console.log(warnBanner("No criteria in the graph."));
        return;
      }

      console.log(label(`Criteria DAG — ${graph.nodes.length} nodes, ${graph.edges.length} edges\n`));

      // Topological layering (Kahn's algorithm)
      const inDegree = new Map<string, number>();
      const children = new Map<string, string[]>();
      for (const n of graph.nodes) {
        inDegree.set(n.id, 0);
        children.set(n.id, []);
      }
      for (const e of graph.edges) {
        inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
        children.get(e.from)?.push(e.to);
      }

      const layers: string[][] = [];
      let queue = graph.nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id);
      while (queue.length > 0) {
        layers.push([...queue]);
        const next: string[] = [];
        for (const id of queue) {
          for (const child of children.get(id) ?? []) {
            const deg = (inDegree.get(child) ?? 1) - 1;
            inDegree.set(child, deg);
            if (deg === 0) next.push(child);
          }
        }
        queue = next;
      }

      // Render layers
      for (let i = 0; i < layers.length; i++) {
        const layerNodes = layers[i];
        const row = layerNodes.map(id => value(id)).join('  ');
        console.log(`  ${dimTimestamp(`Layer ${i}:`)}  ${row}`);
      }

      // Show edges
      if (graph.edges.length > 0) {
        console.log(`\n  ${label('Edges:')}`);
        for (const e of graph.edges) {
          console.log(`    ${value(e.from)} ${styleText('gray', '→')} ${value(e.to)}`);
        }
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

criteria
  .command("import")
  .description("Import criteria from YAML file(s) into the database (upsert — won't overwrite existing)")
  .argument("<path>", "Path to a .yaml file or a directory of .yaml files")
  .option("--dry-run", "Preview what would be imported without sending to API")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (inputPath: string, options) => {
    try {
      const absPath = resolve(inputPath);
      if (!existsSync(absPath)) {
        console.error(errorText(`Path not found: ${absPath}`));
        process.exit(1);
      }

      // Collect YAML files
      let yamlFiles: string[];
      if (statSync(absPath).isDirectory()) {
        yamlFiles = readdirSync(absPath)
          .filter(f => extname(f) === '.yaml' || extname(f) === '.yml')
          .sort()
          .map(f => join(absPath, f));
        if (yamlFiles.length === 0) {
          console.error(errorText(`No .yaml files found in ${absPath}`));
          process.exit(1);
        }
        console.log(`${label('Directory:')} ${value(absPath)} (${yamlFiles.length} files)`);
      } else {
        yamlFiles = [absPath];
        console.log(`${label('File:')} ${value(absPath)}`);
      }

      // Parse all criteria from files (supports multi-document YAML)
      const allCriteria: Array<{ id: string; prompt: string; dependsOn?: string[] }> = [];
      const parseErrors: string[] = [];

      for (const file of yamlFiles) {
        const content = readFileSync(file, 'utf-8');
        const fname = basename(file);

        try {
          // Try multi-document parse first (handles --- separators)
          const docs = parseAllDocuments(content);
          for (let docIdx = 0; docIdx < docs.length; docIdx++) {
            const doc = docs[docIdx].toJSON();
            if (!doc || typeof doc !== 'object') continue;

            const criterion = mapYamlCriterion(doc, fname, docIdx);
            if (criterion) {
              allCriteria.push(criterion);
            } else {
              parseErrors.push(`${fname}${docs.length > 1 ? ` (doc ${docIdx + 1})` : ''}: missing id or prompt`);
            }
          }
        } catch (e) {
          parseErrors.push(`${fname}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (parseErrors.length > 0) {
        console.log(`\n${warnBanner('Parse warnings:')}`);
        for (const err of parseErrors) {
          console.log(`  ${errorText('⚠')} ${err}`);
        }
      }

      if (allCriteria.length === 0) {
        console.error(errorText('No valid criteria found to import.'));
        process.exit(1);
      }

      console.log(`\n${label('Parsed:')} ${value(String(allCriteria.length))} criteria`);

      // Show preview
      for (const c of allCriteria) {
        const deps = (c.dependsOn ?? []).length;
        const depsStr = deps > 0 ? ` ${dimTimestamp(`(${deps} dep${deps > 1 ? 's' : ''})`)}` : '';
        console.log(`  ${value(c.id)}${depsStr}`);
      }

      if (options.dryRun) {
        console.log(`\n${warnBanner('Dry run — no changes made.')}`);
        return;
      }

      // Seed via API
      console.log();
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/criteria/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criteria: allCriteria }),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const result = await response.json() as { seeded: number; errors: string[] };
      console.log(`${successText('Seeded:')} ${value(String(result.seeded))} criteria`);
      if (result.seeded < allCriteria.length) {
        console.log(`${dimTimestamp(`(${allCriteria.length - result.seeded} already existed — skipped)`)}`);
      }
      if (result.errors.length > 0) {
        console.log(`\n${warnBanner('Seed errors:')}`);
        for (const err of result.errors) {
          console.log(`  ${errorText('⚠')} ${err}`);
        }
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Map a parsed YAML object to a criteria API payload.
 * Handles snake_case `depends_on` → camelCase `dependsOn` conversion.
 */
function mapYamlCriterion(
  doc: Record<string, unknown>,
  filename: string,
  _docIndex: number
): { id: string; prompt: string; dependsOn?: string[] } | null {
  const id = doc.id as string | undefined;
  const prompt = doc.prompt as string | undefined;
  if (!id || !prompt) return null;

  // Support both snake_case (YAML convention) and camelCase
  const depsRaw = (doc.depends_on ?? doc.dependsOn) as string[] | undefined;
  const dependsOn = Array.isArray(depsRaw) ? depsRaw.map(d => String(d).trim()) : undefined;

  return {
    id: id.trim(),
    prompt: prompt.trim(),
    ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
  };
}

program.parse();

