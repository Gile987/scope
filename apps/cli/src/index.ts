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
import { configureHelp, generateOutputFormatsHelp } from "./utils/helpFormatter.js";
import { colorLevel, dimTimestamp, errorText, successText, label, value, banner, warnBanner, criterionIcon, styleText } from "./utils/style.js";
import { formatData, isMachineReadable } from "./utils/formatters.js";
import type { OutputFormat, DisplayField } from "./utils/types.js";
import { runGetAction } from "./run-get-action.js";

dotenv.config();

/** Strip trailing slashes from a URL to avoid double-slash issues when appending paths */
const normalizeUrl = (url: string): string => url.replace(/\/+$/, '');

function printFollowUpCommands(id: string): void {
  console.log(`\n${label('Run ID:')} ${value(id)}`);
  console.log(`\n${label('Next steps:')}`);
  console.log(`  ${dimTimestamp('Get details:')}   pnpm cli run get -i ${id}`);
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

// Output format definitions with descriptions and categories
const OUTPUT_FORMATS = {
  table: { section: 'Human-readable formats', description: 'Formatted table with borders (default for lists)' },
  tsv:   { section: 'Machine-readable formats', description: 'Tab-separated values for Unix tools (cut, awk, grep, xargs)' },
  json:  { section: 'Machine-readable formats', description: 'JSON format for programmatic access and AI agents' },
} as const;

program
  .name("scope-mt")
  .description("Scope MT — AI coding agent benchmarking CLI")
  .version("1.0.0")
  .action(() => {
    program.help();
  })
  .addHelpText('after', generateOutputFormatsHelp(OUTPUT_FORMATS));

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
  .option("--model <model>", "Model to use for the coding agent")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("--no-stream", "Don't stream logs, just submit")
  .action(async (options) => {
    const { scenario, persona, traits, worker, url, stream, maxIterations, model } = options;

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
      if (model) {
        body.model = model;
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
      if (result.model) console.log(`${label('Model:')} ${value(result.model)}`);
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
  .command("get")
  .description("Get full details of a run")
  .requiredOption("-i, --id <id>", "Run ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("-o, --output <format>", "Output format: table, tsv, or json", "table")
  .action(async (options) => {
    await runGetAction({ id: options.id, url: options.url, output: options.output });
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
  .option("-o, --output <format>", "Output format: table, tsv, or json", "table")
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
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
        if (!isMachineReadable(format)) console.log(warnBanner('No requests found.'));
        return;
      }
      if (Array.isArray(requests)) {
        if (!isMachineReadable(format)) {
          console.log(label(`Found ${requests.length} request(s):\n`));
        }

        const displayFields: DisplayField[] = [
          { key: 'id', label: 'ID',
            formatter: (req: any) => req.id ?? '(no id)',
            tableFormatter: (req: any) => value(req.id ?? '(no id)'),
          },
          { key: 'workerType', label: 'Worker',
            formatter: (req: any) => req.workerType ?? 'unknown',
          },
          { key: 'status', label: 'Status',
            formatter: (req: any) => req.status ?? 'unknown',
            tableFormatter: (req: any) => {
              const s = req.status ?? 'unknown';
              return s === 'completed' ? successText(s) : s === 'failed' ? errorText(s) : value(s);
            },
          },
        ];

        console.log(formatData(requests, displayFields, format));
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
        // Step 3: Write run document as YAML
        writeFileSync(join(runDir, "run.yaml"), yamlStringify(request, { lineWidth: 120 }));
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

run
  .command("upload")
  .description("Upload a run archive to the API (previously downloaded via 'run download')")
  .argument("<path>", "Path to .tar.gz archive or extracted directory")
  .option("--dry-run", "Preview what would be uploaded without sending")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (inputPath: string, options) => {
    const { url, dryRun } = options;

    try {
      const resolvedPath = resolve(inputPath);
      
      // Check if path exists
      if (!existsSync(resolvedPath)) {
        console.error(errorText(`Path not found: ${resolvedPath}`));
        process.exit(1);
      }

      const stats = statSync(resolvedPath);
      let archivePath: string;
      let tempDir: string | undefined;

      if (stats.isDirectory()) {
        // Directory: validate run.yaml exists, then create tar.gz
        const runYamlPath = join(resolvedPath, "run.yaml");
        if (!existsSync(runYamlPath)) {
          console.error(errorText(`Invalid directory: run.yaml not found at ${runYamlPath}`));
          process.exit(1);
        }

        // Create temporary tar.gz archive
        tempDir = mkdtempSync(join(tmpdir(), "scope-mt-upload-"));
        archivePath = join(tempDir, `${basename(resolvedPath)}.tar.gz`);
        
        console.log(`${label('Creating archive from')} ${value(resolvedPath)}...`);
        execSync(`tar czf "${archivePath}" -C "${dirname(resolvedPath)}" "${basename(resolvedPath)}"`, { stdio: "pipe" });
      } else if (resolvedPath.endsWith(".tar.gz")) {
        // Archive file: use as-is
        archivePath = resolvedPath;
      } else {
        console.error(errorText("Input must be a .tar.gz archive or a directory"));
        process.exit(1);
      }

      const archiveStats = statSync(archivePath);
      const archiveSizeKB = Math.round(archiveStats.size / 1024);

      console.log(`${label('Archive:')} ${value(archivePath)}`);
      console.log(`${label('Size:')} ${value(`${archiveSizeKB} KB`)}`);
      console.log();

      if (dryRun) {
        console.log(warnBanner("Dry run - no data will be uploaded"));
        console.log(`Would upload to: ${normalizeUrl(url)}/api/v1/runs/upload`);
        
        // Cleanup temp dir if created
        if (tempDir) {
          rmSync(tempDir, { recursive: true, force: true });
        }
        return;
      }

      // Upload archive
      console.log(`${label('Uploading to')} ${value(normalizeUrl(url))}...`);
      
      const formData = new FormData();
      const archiveBuffer = readFileSync(archivePath);
      const blob = new Blob([archiveBuffer], { type: "application/gzip" });
      formData.append("archive", blob, basename(archivePath));

      const response = await fetch(`${normalizeUrl(url)}/api/v1/runs/upload`, {
        method: "POST",
        body: formData,
      });

      // Cleanup temp dir if created
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: response.statusText }));
        
        if (response.status === 409) {
          console.error(errorText(`Error: ${errorData.error || "Run already exists"}`));
        } else if (response.status === 400) {
          console.error(errorText(`Error: ${errorData.error || "Invalid archive"}`));
        } else {
          console.error(errorText(`Error: ${errorData.error || response.statusText}`));
        }
        process.exit(1);
      }

      const result = await response.json();
      console.log();
      console.log(successText("Run uploaded successfully!"));
      console.log(`${label('Run ID:')} ${value(result.id)}`);
      console.log(`${label('Status:')} ${value(result.status)}`);
      console.log(`${label('Iterations:')} ${value(String(result.iterations))}`);

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
  .option("-o, --output <format>", "Output format: table, tsv, or json", "table")
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
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
        if (!isMachineReadable(format)) console.log(warnBanner("No criteria found."));
        return;
      }

      if (!isMachineReadable(format)) {
        console.log(label(`Found ${items.length} criteria:\n`));
      }

      const displayFields: DisplayField[] = [
        { key: 'id', label: 'ID',
          tableFormatter: (c: any) => value(c.id),
        },
        { key: 'dependsOn', label: 'Deps', formatter: (c: any) => String((c.dependsOn ?? []).length) },
        { key: 'prompt', label: 'Prompt', formatter: (c: any) => {
          const prompt = c.prompt.replace(/\n/g, ' ');
          return prompt.length > 60 ? prompt.substring(0, 60) + '…' : prompt;
        }, tableFormatter: (c: any) => {
          const prompt = c.prompt.replace(/\n/g, ' ');
          const truncated = prompt.length > 60 ? prompt.substring(0, 60) + '…' : prompt;
          return dimTimestamp(truncated);
        }},
      ];

      console.log(formatData(items, displayFields, format));
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
        edges: Array<{ source: string; target: string }>;
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
        inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
        children.get(e.source)?.push(e.target);
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
          console.log(`    ${value(e.source)} ${styleText('gray', '→')} ${value(e.target)}`);
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

// ─── Prompt Feature management ───────────────────────────────────────────────

const promptFeature = program
  .command("prompt-feature")
  .description("Manage prompt features (CRUD, import, extract, graph)")
  .action(() => {
    promptFeature.help();
  });

configureHelp(promptFeature);

promptFeature
  .command("list")
  .description("List all prompt features")
  .option("-q, --query <search>", "Filter by ID or prompt text")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("-o, --output <format>", "Output format: table, tsv, or json", "table")
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const params = new URLSearchParams();
      if (options.query) params.set("q", options.query);
      const qs = params.toString();
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/prompt-features${qs ? `?${qs}` : ""}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const items = await response.json() as Array<{ id: string; prompt: string; dependsOn?: string[] }>;
      if (items.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No prompt features found."));
        return;
      }

      if (!isMachineReadable(format)) {
        console.log(label(`Found ${items.length} prompt features:\n`));
      }

      const displayFields: DisplayField[] = [
        { key: 'id', label: 'ID',
          tableFormatter: (f: any) => value(f.id),
        },
        { key: 'dependsOn', label: 'Deps', formatter: (f: any) => String((f.dependsOn ?? []).length) },
        { key: 'prompt', label: 'Prompt', formatter: (f: any) => {
          const prompt = f.prompt.replace(/\n/g, ' ');
          return prompt.length > 60 ? prompt.substring(0, 60) + '…' : prompt;
        }, tableFormatter: (f: any) => {
          const prompt = f.prompt.replace(/\n/g, ' ');
          const truncated = prompt.length > 60 ? prompt.substring(0, 60) + '…' : prompt;
          return dimTimestamp(truncated);
        }},
      ];

      console.log(formatData(items, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

promptFeature
  .command("get")
  .description("Get details of a single prompt feature")
  .requiredOption("-i, --id <id>", "Prompt feature ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/prompt-features/${options.id}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const f = await response.json() as {
        id: string; prompt: string; dependsOn?: string[];
        dependents: string[]; createdAt: string; updatedAt?: string;
      };

      console.log(`${label('ID:')}        ${value(f.id)}`);
      console.log(`${label('Prompt:')}`);
      for (const line of f.prompt.trim().split('\n')) {
        console.log(`  ${line}`);
      }
      if ((f.dependsOn ?? []).length > 0) {
        console.log(`${label('Depends on:')} ${f.dependsOn!.map(d => value(d)).join(', ')}`);
      } else {
        console.log(`${label('Depends on:')} ${dimTimestamp('(none — root feature)')}`);
      }
      if (f.dependents.length > 0) {
        console.log(`${label('Dependents:')} ${f.dependents.map(d => value(d)).join(', ')}`);
      }
      console.log(`${label('Created:')}   ${value(f.createdAt)}`);
      if (f.updatedAt) console.log(`${label('Updated:')}   ${value(f.updatedAt)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

promptFeature
  .command("create")
  .description("Create a new prompt feature")
  .requiredOption("--id <id>", "Prompt feature ID (lowercase snake_case)")
  .requiredOption("--prompt <prompt>", "Detection prompt for the feature")
  .option("-d, --depends-on <ids...>", "IDs of parent features")
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

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/prompt-features`, {
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
      console.log(`${successText('Created prompt feature')} ${value(created.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

promptFeature
  .command("update")
  .description("Update an existing prompt feature")
  .requiredOption("-i, --id <id>", "Prompt feature ID")
  .option("--prompt <prompt>", "New detection prompt")
  .option("-d, --depends-on <ids...>", "New parent feature IDs (replaces all)")
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

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/prompt-features/${options.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      console.log(`${successText('Updated prompt feature')} ${value(options.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

promptFeature
  .command("delete")
  .description("Delete a prompt feature (soft-delete; fails if other features depend on it)")
  .requiredOption("-i, --id <id>", "Prompt feature ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/prompt-features/${options.id}`, {
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

      console.log(`${successText('Deleted prompt feature')} ${value(options.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

promptFeature
  .command("graph")
  .description("Display the prompt feature dependency graph as ASCII")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/prompt-features/graph`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const graph = await response.json() as {
        nodes: Array<{ id: string; prompt: string; dependsOn: string[] }>;
        edges: Array<{ source: string; target: string }>;
      };

      if (graph.nodes.length === 0) {
        console.log(warnBanner("No prompt features in the graph."));
        return;
      }

      console.log(label(`Prompt Feature DAG — ${graph.nodes.length} nodes, ${graph.edges.length} edges\n`));

      const inDegree = new Map<string, number>();
      const children = new Map<string, string[]>();
      for (const n of graph.nodes) {
        inDegree.set(n.id, 0);
        children.set(n.id, []);
      }
      for (const e of graph.edges) {
        inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
        children.get(e.source)?.push(e.target);
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

      for (let i = 0; i < layers.length; i++) {
        const layerNodes = layers[i];
        const row = layerNodes.map(id => value(id)).join('  ');
        console.log(`  ${dimTimestamp(`Layer ${i}:`)}  ${row}`);
      }

      if (graph.edges.length > 0) {
        console.log(`\n  ${label('Edges:')}`);
        for (const e of graph.edges) {
          console.log(`    ${value(e.source)} ${styleText('gray', '→')} ${value(e.target)}`);
        }
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

promptFeature
  .command("import")
  .description("Import prompt features from YAML file(s) into the database (upsert)")
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

      const allFeatures: Array<{ id: string; prompt: string; dependsOn?: string[] }> = [];
      const parseErrors: string[] = [];

      for (const file of yamlFiles) {
        const content = readFileSync(file, 'utf-8');
        const fname = basename(file);

        try {
          const docs = parseAllDocuments(content);
          for (let docIdx = 0; docIdx < docs.length; docIdx++) {
            const doc = docs[docIdx].toJSON();
            if (!doc || typeof doc !== 'object') continue;

            // Reuse the same YAML mapping logic
            const feature = mapYamlCriterion(doc, fname, docIdx);
            if (feature) {
              allFeatures.push(feature);
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

      if (allFeatures.length === 0) {
        console.error(errorText('No valid prompt features found to import.'));
        process.exit(1);
      }

      console.log(`\n${label('Parsed:')} ${value(String(allFeatures.length))} prompt features`);

      for (const f of allFeatures) {
        const deps = (f.dependsOn ?? []).length;
        const depsStr = deps > 0 ? ` ${dimTimestamp(`(${deps} dep${deps > 1 ? 's' : ''})`)}` : '';
        console.log(`  ${value(f.id)}${depsStr}`);
      }

      if (options.dryRun) {
        console.log(`\n${warnBanner('Dry run — no changes made.')}`);
        return;
      }

      console.log();
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/prompt-features/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: allFeatures }),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const result = await response.json() as { seeded: number; errors: string[] };
      console.log(`${successText('Seeded:')} ${value(String(result.seeded))} prompt features`);
      if (result.seeded < allFeatures.length) {
        console.log(`${dimTimestamp(`(${allFeatures.length - result.seeded} already existed — skipped)`)}`);
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

promptFeature
  .command("extract")
  .description("Extract prompt features from a task text or scenario file")
  .option("-t, --task <text>", "Task text to analyze")
  .option("-s, --scenario <path>", "Path to scenario YAML file (uses its task text)")
  .option("--model <model>", "LLM model to use for extraction")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      let taskText = options.task;

      if (!taskText && options.scenario) {
        const absPath = resolve(options.scenario);
        if (!existsSync(absPath)) {
          console.error(errorText(`Scenario file not found: ${absPath}`));
          process.exit(1);
        }
        const content = readFileSync(absPath, 'utf-8');
        const parsed = yamlParse(content);
        taskText = parsed?.task || parsed?.scenario?.task;
        if (!taskText) {
          console.error(errorText("Could not find 'task' field in scenario file"));
          process.exit(1);
        }
        console.log(`${label('Scenario:')} ${value(basename(absPath))}`);
      }

      if (!taskText) {
        console.error(errorText("Error: provide --task or --scenario"));
        process.exit(1);
      }

      console.log(`${label('Extracting prompt features...')}`);

      const body: Record<string, unknown> = { taskText };
      if (options.model) body.model = options.model;

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/prompt-features/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const extraction = await response.json() as {
        promptFeatureResults: Array<{ featureId: string; detected: boolean; evaluated: boolean }>;
        extractedAt: string;
        model?: string;
      };

      const detected = extraction.promptFeatureResults.filter(r => r.detected);
      const notDetected = extraction.promptFeatureResults.filter(r => !r.detected && r.evaluated);
      const skipped = extraction.promptFeatureResults.filter(r => !r.evaluated);

      console.log(`\n${label('Results:')}`);
      if (detected.length > 0) {
        console.log(`  ${successText('Detected:')}`);
        for (const r of detected) {
          console.log(`    ${criterionIcon(true, true)} ${value(r.featureId)}`);
        }
      }
      if (notDetected.length > 0) {
        console.log(`  ${dimTimestamp('Not detected:')}`);
        for (const r of notDetected) {
          console.log(`    ${criterionIcon(true, false)} ${dimTimestamp(r.featureId)}`);
        }
      }
      if (skipped.length > 0) {
        console.log(`  ${warnBanner('Skipped (not evaluated):')}`);
        for (const r of skipped) {
          console.log(`    ○ ${dimTimestamp(r.featureId)}`);
        }
      }

      console.log(`\n${label('Summary:')} ${value(String(detected.length))} detected, ${dimTimestamp(String(notDetected.length))} not detected, ${dimTimestamp(String(skipped.length))} skipped`);
      if (extraction.model) console.log(`${label('Model:')}   ${value(extraction.model)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ─── Report management ──────────────────────────────────────────────────────

const report = program
  .command("report")
  .description("Generate, view, and monitor run reports")
  .action(() => {
    report.help();
  });

configureHelp(report);

report
  .command("generate")
  .description("Generate a report for a benchmark run")
  .requiredOption("-i, --id <requestId>", "Run ID to generate a report for")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("--stream", "Stream report generation logs in real time", true)
  .option("--no-stream", "Do not stream logs after submission")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: options.id }),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const result = await response.json() as { id: string; requestId: string; status: string };
      console.log(`${successText("Report queued")} ${dimTimestamp(`(${result.id})`)}`);
      console.log(`${label('Report ID:')} ${value(result.id)}`);
      console.log(`${label('Run ID:')}    ${value(result.requestId)}`);

      if (options.stream) {
        console.log(`\n${label('Streaming logs...')}\n`);
        const eventSource = new EventSource(
          `${normalizeUrl(options.url)}/api/v1/reports/${result.id}/logs?fromStart=true`
        );

        eventSource.onmessage = (event: MessageEvent) => {
          try {
            const log = JSON.parse(event.data) as {
              timestamp: string;
              level: string;
              source?: string;
              message: string;
            };
            const ts = dimTimestamp(new Date(log.timestamp).toLocaleTimeString());
            const lvl = colorLevel(log.level);
            const src = log.source ? ` ${dimTimestamp(`[${log.source}]`)}` : "";
            console.log(`${ts} ${lvl}${src} ${log.message}`);
          } catch {
            console.log(event.data);
          }
        };

        eventSource.addEventListener("done", () => {
          console.log(`\n${successText("Report generation complete")}`);
          console.log(`\n${label('Next steps:')}`);
          console.log(`  ${dimTimestamp('View report:')} pnpm cli report get -i ${result.id}`);
          eventSource.close();
          process.exit(0);
        });

        eventSource.addEventListener("timeout", () => {
          console.log(`\n${warnBanner("Stream timed out")}`);
          eventSource.close();
          process.exit(0);
        });

        eventSource.onerror = () => {
          eventSource.close();
          process.exit(1);
        };
      } else {
        console.log(`\n${label('Next steps:')}`);
        console.log(`  ${dimTimestamp('Stream logs:')}  pnpm cli report logs -i ${result.id}`);
        console.log(`  ${dimTimestamp('View report:')} pnpm cli report get -i ${result.id}`);
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

report
  .command("get")
  .description("Get a report by ID")
  .requiredOption("-i, --id <reportId>", "Report ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("--raw", "Output raw markdown without formatting")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/reports/${options.id}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const report = await response.json() as {
        id: string;
        requestId: string;
        status: string;
        reporter?: { id: string; name: string; model: string; agentId: string; agentVersion: string };
        content?: string;
        createdAt: string;
        updatedAt?: string;
        error?: string;
      };

      if (options.raw && report.content) {
        console.log(report.content);
        return;
      }

      console.log(`${label('Report:')}    ${value(report.id)}`);
      console.log(`${label('Run:')}       ${value(report.requestId)}`);
      console.log(`${label('Status:')}    ${colorLevel(report.status === "completed" ? "info" : report.status === "failed" ? "error" : "warn")} ${report.status}`);
      console.log(`${label('Created:')}   ${dimTimestamp(new Date(report.createdAt).toLocaleString())}`);
      if (report.updatedAt) {
        console.log(`${label('Updated:')}   ${dimTimestamp(new Date(report.updatedAt).toLocaleString())}`);
      }
      if (report.reporter) {
        console.log(`${label('Reporter:')}  ${value(report.reporter.name)} (${report.reporter.agentId}@${report.reporter.agentVersion})`);
        console.log(`${label('Model:')}     ${value(report.reporter.model)}`);
      }
      if (report.error) {
        console.log(`${label('Error:')}     ${errorText(report.error)}`);
      }
      if (report.content) {
        console.log(`\n${banner('─── Report Content ───')}\n`);
        console.log(report.content);
      } else if (report.status === "pending" || report.status === "generating") {
        console.log(`\n${dimTimestamp('Report is still being generated. Stream logs with:')}`);
        console.log(`  pnpm cli report logs -i ${report.id}`);
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

report
  .command("list")
  .description("List all reports (optionally filter by run)")
  .option("-r, --run <requestId>", "Filter by run ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("-o, --output <format>", "Output format: table, tsv, or json", "table")
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const params = new URLSearchParams();
      if (options.run) params.set("requestId", options.run);
      const qs = params.toString();
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/reports${qs ? `?${qs}` : ""}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const reports = await response.json() as Array<{
        id: string;
        requestId: string;
        status: string;
        reporter?: { model: string };
        createdAt: string;
      }>;

      if (reports.length === 0) {
        if (!isMachineReadable(format)) console.log(dimTimestamp("No reports found"));
        return;
      }

      if (!isMachineReadable(format)) {
        console.log(`${label(`Reports (${reports.length}):`)}\n`);
      }

      const displayFields: DisplayField[] = [
        { key: 'id', label: 'ID',
          tableFormatter: (r: any) => value(r.id),
        },
        { key: 'requestId', label: 'Run ID',
          tableFormatter: (r: any) => dimTimestamp(r.requestId),
        },
        { key: 'status', label: 'Status',
          tableFormatter: (r: any) => {
            return r.status === 'completed' ? successText('✓ ' + r.status)
              : r.status === 'failed' ? errorText('✗ ' + r.status)
              : dimTimestamp('… ' + r.status);
          },
        },
        { key: 'model', label: 'Model', formatter: (r: any) => r.reporter?.model ?? 'N/A',
          tableFormatter: (r: any) => r.reporter?.model ? dimTimestamp(r.reporter.model) : 'N/A',
        },
        { key: 'createdAt', label: 'Created', formatter: (r: any) => new Date(r.createdAt).toLocaleString(),
          tableFormatter: (r: any) => dimTimestamp(new Date(r.createdAt).toLocaleString()),
        },
      ];

      console.log(formatData(reports, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

report
  .command("logs")
  .description("Stream report generation logs")
  .requiredOption("-i, --id <reportId>", "Report ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("--from-start", "Include historical logs from the beginning", false)
  .action(async (options) => {
    try {
      // Verify report exists first
      const checkResponse = await fetch(`${normalizeUrl(options.url)}/api/v1/reports/${options.id}`);
      if (!checkResponse.ok) {
        const error = await checkResponse.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const fromStartParam = options.fromStart ? "&fromStart=true" : "";
      const eventSource = new EventSource(
        `${normalizeUrl(options.url)}/api/v1/reports/${options.id}/logs?${fromStartParam}`
      );

      eventSource.onmessage = (event: MessageEvent) => {
        try {
          const log = JSON.parse(event.data) as {
            timestamp: string;
            level: string;
            source?: string;
            message: string;
          };
          const ts = dimTimestamp(new Date(log.timestamp).toLocaleTimeString());
          const lvl = colorLevel(log.level);
          const src = log.source ? ` ${dimTimestamp(`[${log.source}]`)}` : "";
          console.log(`${ts} ${lvl}${src} ${log.message}`);
        } catch {
          console.log(event.data);
        }
      };

      eventSource.addEventListener("done", () => {
        console.log(`\n${successText("Report generation complete")}`);
        eventSource.close();
        process.exit(0);
      });

      eventSource.addEventListener("timeout", () => {
        console.log(`\n${warnBanner("Stream timed out")}`);
        eventSource.close();
        process.exit(0);
      });

      eventSource.onerror = () => {
        eventSource.close();
        process.exit(1);
      };
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ─── Agent management ────────────────────────────────────────────────────────

const agent = program
  .command("agent")
  .description("Manage coding agent definitions and their supported models")
  .action(() => {
    agent.help();
  });

configureHelp(agent);

agent
  .command("list")
  .description("List all coding agents")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("-o, --output <format>", "Output format: table, tsv, or json", "table")
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/agents`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const agents = await response.json() as Array<{ _id: string; name: string; supportedModels: string[]; defaultModel?: string }>;
      if (agents.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No agents found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${agents.length} agents:\n`));
      }
      const displayFields: DisplayField[] = [
        { key: '_id', label: 'ID', tableFormatter: (a: any) => value(a._id) },
        { key: 'name', label: 'Name' },
        { key: 'supportedModels', label: 'Models', formatter: (a: any) => (a.supportedModels || []).join(', ') || '—' },
        { key: 'defaultModel', label: 'Default', formatter: (a: any) => a.defaultModel || '—' },
      ];
      console.log(formatData(agents, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

agent
  .command("get")
  .description("Get details of a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/agents/${encodeURIComponent(options.id)}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const agentDoc = await response.json();
      console.log(`${label('ID:')} ${value(agentDoc._id)}`);
      console.log(`${label('Name:')} ${value(agentDoc.name)}`);
      if (agentDoc.description) console.log(`${label('Description:')} ${agentDoc.description}`);
      console.log(`${label('Supported Models:')} ${(agentDoc.supportedModels || []).join(', ') || '(none)'}`);
      console.log(`${label('Default Model:')} ${agentDoc.defaultModel || '(none)'}`);
      console.log(`${label('Created:')} ${new Date(agentDoc.createdAt).toLocaleString()}`);
      if (agentDoc.updatedAt) console.log(`${label('Updated:')} ${new Date(agentDoc.updatedAt).toLocaleString()}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

agent
  .command("update")
  .description("Update a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .option("--name <name>", "Display name")
  .option("--description <desc>", "Description")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {};
      if (options.name) body.name = options.name;
      if (options.description) body.description = options.description;
      if (Object.keys(body).length === 0) {
        console.error(errorText("Error: provide at least one field to update (--name, --description)"));
        process.exit(1);
      }
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/agents/${encodeURIComponent(options.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const updated = await response.json();
      console.log(successText(`Agent ${updated._id} updated.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

agent
  .command("delete")
  .description("Delete a coding agent (soft-delete)")
  .requiredOption("-i, --id <id>", "Agent ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/agents/${encodeURIComponent(options.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Agent ${options.id} deleted.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ─── Agent model sub-commands ────────────────────────────────────────────────

const agentModel = agent
  .command("model")
  .description("Manage supported models for a coding agent")
  .action(() => {
    agentModel.help();
  });

configureHelp(agentModel);

agentModel
  .command("list")
  .description("List supported models for a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("-o, --output <format>", "Output format: table, tsv, or json", "table")
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/agents/${encodeURIComponent(options.id)}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const agentDoc = await response.json();
      const models = (agentDoc.supportedModels || []) as string[];
      if (models.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner(`Agent ${agentDoc._id} has no supported models.`));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Models for ${agentDoc._id}:\n`));
      }
      const items = models.map((m: string) => ({ model: m, default: m === agentDoc.defaultModel ? '✓' : '' }));
      const displayFields: DisplayField[] = [
        { key: 'model', label: 'Model', tableFormatter: (r: any) => value(r.model) },
        { key: 'default', label: 'Default' },
      ];
      console.log(formatData(items, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

agentModel
  .command("add")
  .description("Add a supported model to a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .requiredOption("--model <model>", "Model name to add")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      // Fetch current agent
      const getResp = await fetch(`${normalizeUrl(options.url)}/api/v1/agents/${encodeURIComponent(options.id)}`);
      if (!getResp.ok) {
        const error = await getResp.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const agentDoc = await getResp.json();
      const models: string[] = agentDoc.supportedModels || [];
      if (models.includes(options.model)) {
        console.log(warnBanner(`Model ${options.model} is already supported by ${agentDoc._id}.`));
        return;
      }
      models.push(options.model);
      const putResp = await fetch(`${normalizeUrl(options.url)}/api/v1/agents/${encodeURIComponent(options.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supportedModels: models }),
      });
      if (!putResp.ok) {
        const error = await putResp.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Model ${options.model} added to ${agentDoc._id}.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

agentModel
  .command("remove")
  .description("Remove a supported model from a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .requiredOption("--model <model>", "Model name to remove")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const getResp = await fetch(`${normalizeUrl(options.url)}/api/v1/agents/${encodeURIComponent(options.id)}`);
      if (!getResp.ok) {
        const error = await getResp.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const agentDoc = await getResp.json();
      const models: string[] = agentDoc.supportedModels || [];
      const idx = models.indexOf(options.model);
      if (idx === -1) {
        console.log(warnBanner(`Model ${options.model} is not supported by ${agentDoc._id}.`));
        return;
      }
      models.splice(idx, 1);
      const body: Record<string, unknown> = { supportedModels: models };
      // If removed model was the default, clear defaultModel
      if (agentDoc.defaultModel === options.model) {
        body.defaultModel = null;
      }
      const putResp = await fetch(`${normalizeUrl(options.url)}/api/v1/agents/${encodeURIComponent(options.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!putResp.ok) {
        const error = await putResp.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Model ${options.model} removed from ${agentDoc._id}.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

agentModel
  .command("set-default")
  .description("Set the default model for a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .requiredOption("--model <model>", "Model name to set as default")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      // Verify the model is supported
      const getResp = await fetch(`${normalizeUrl(options.url)}/api/v1/agents/${encodeURIComponent(options.id)}`);
      if (!getResp.ok) {
        const error = await getResp.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const agentDoc = await getResp.json();
      const models: string[] = agentDoc.supportedModels || [];
      if (!models.includes(options.model)) {
        console.error(errorText(`Error: model ${options.model} is not in the supported models for ${agentDoc._id}. Add it first with: agent model add -i ${agentDoc._id} --model ${options.model}`));
        process.exit(1);
      }
      const putResp = await fetch(`${normalizeUrl(options.url)}/api/v1/agents/${encodeURIComponent(options.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultModel: options.model }),
      });
      if (!putResp.ok) {
        const error = await putResp.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Default model for ${agentDoc._id} set to ${options.model}.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ─── Insight management ──────────────────────────────────────────────────────

const insight = program
  .command("insight")
  .description("Manage insights discovered during report analysis")
  .action(() => {
    insight.help();
  });

configureHelp(insight);

insight
  .command("list")
  .description("List all insights")
  .option("-q, --query <query>", "Search by keyword")
  .option("--blocked", "Show only blocked insights")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .option("-o, --output <format>", "Output format: table, tsv, or json", "table")
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const params = new URLSearchParams();
      if (options.query) params.set("q", options.query);
      if (options.blocked) params.set("blocked", "true");
      const qs = params.toString();
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/insights${qs ? `?${qs}` : ""}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const insights = await response.json();
      if (insights.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No insights found."));
        return;
      }
      const displayFields: DisplayField[] = [
        { key: '_id', label: 'ID', tableFormatter: (r: any) => value(r._id.slice(0, 8) + '…') },
        { key: 'title', label: 'Title', formatter: (r: any) => r.title.length > 60 ? r.title.slice(0, 57) + '…' : r.title },
        { key: 'category', label: 'Category', formatter: (r: any) => r.category || '—' },
        { key: 'referenceCount', label: 'Refs', formatter: (r: any) => String(r.referenceCount) },
        { key: 'votes', label: 'Votes', formatter: (r: any) => String(r.upvotes - r.downvotes) },
        { key: 'blocked', label: 'Blocked', formatter: (r: any) => r.blocked ? '✗' : '' },
        { key: 'createdBy', label: 'Source' },
      ];
      console.log(formatData(insights, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("get")
  .description("Get details of an insight (renders markdown description)")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("--raw", "Print raw markdown without formatting")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/insights/${encodeURIComponent(options.id)}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const insightDoc = await response.json();

      if (options.raw) {
        console.log(insightDoc.description);
        return;
      }

      console.log(`${label('ID:')} ${value(insightDoc._id)}`);
      console.log(`${label('Title:')} ${value(insightDoc.title)}`);
      if (insightDoc.category) console.log(`${label('Category:')} ${insightDoc.category}`);
      if (insightDoc.tags?.length) console.log(`${label('Tags:')} ${insightDoc.tags.join(', ')}`);
      console.log(`${label('Votes:')} ▲${insightDoc.upvotes} ▼${insightDoc.downvotes} (net: ${insightDoc.upvotes - insightDoc.downvotes})`);
      console.log(`${label('References:')} ${insightDoc.referenceCount} reports`);
      console.log(`${label('Blocked:')} ${insightDoc.blocked ? 'Yes' : 'No'}`);
      console.log(`${label('Created by:')} ${insightDoc.createdBy}`);
      if (insightDoc.sourceReportId) console.log(`${label('Source report:')} ${insightDoc.sourceReportId}`);
      console.log(`${label('Created:')} ${new Date(insightDoc.createdAt).toLocaleString()}`);
      if (insightDoc.updatedAt) console.log(`${label('Updated:')} ${new Date(insightDoc.updatedAt).toLocaleString()}`);
      console.log(`\n${label('Description:')}\n${insightDoc.description}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("create")
  .description("Create a new insight")
  .requiredOption("--title <title>", "Short summary (one line)")
  .requiredOption("--description <description>", "Markdown description")
  .option("--category <category>", "Category tag")
  .option("--tags <tags>", "Comma-separated tags")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {
        title: options.title,
        description: options.description,
        createdBy: "user",
      };
      if (options.category) body.category = options.category;
      if (options.tags) body.tags = options.tags.split(",").map((t: string) => t.trim()).filter(Boolean);

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/insights`, {
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
      console.log(successText(`Insight created: ${created._id}`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("update")
  .description("Update an insight")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("--title <title>", "New title")
  .option("--description <description>", "New markdown description")
  .option("--category <category>", "New category")
  .option("--tags <tags>", "New comma-separated tags")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {};
      if (options.title) body.title = options.title;
      if (options.description) body.description = options.description;
      if (options.category) body.category = options.category;
      if (options.tags) body.tags = options.tags.split(",").map((t: string) => t.trim()).filter(Boolean);
      if (Object.keys(body).length === 0) {
        console.error(errorText("Error: provide at least one field to update"));
        process.exit(1);
      }
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/insights/${encodeURIComponent(options.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Insight ${options.id} updated.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("delete")
  .description("Delete an insight (soft-delete)")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/insights/${encodeURIComponent(options.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Insight ${options.id} deleted.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("upvote")
  .description("Upvote an insight")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/insights/${encodeURIComponent(options.id)}/upvote`, {
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const updated = await response.json();
      console.log(successText(`Upvoted. Score: ▲${updated.upvotes} ▼${updated.downvotes}`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("downvote")
  .description("Downvote an insight")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/insights/${encodeURIComponent(options.id)}/downvote`, {
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const updated = await response.json();
      console.log(successText(`Downvoted. Score: ▲${updated.upvotes} ▼${updated.downvotes}`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("block")
  .description("Block an insight")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/insights/${encodeURIComponent(options.id)}/block`, {
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Insight ${options.id} blocked.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("unblock")
  .description("Unblock an insight")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_MT_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/insights/${encodeURIComponent(options.id)}/unblock`, {
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Insight ${options.id} unblocked.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();

