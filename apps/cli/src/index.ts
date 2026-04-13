#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import dotenv from "dotenv";
import { Command } from "commander";
import EventSource from "eventsource";
import { execSync } from "child_process";
import { mkdtempSync, mkdirSync, createWriteStream, rmSync, readFileSync, readdirSync, existsSync, statSync } from "fs";
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

export const program = new Command();

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
  yaml:  { section: 'Machine-readable formats', description: 'YAML format for human-friendly structured data' },
} as const;

/**
 * Add the standard `-o, --output <format>` option to a command.
 * @param cmd - The Commander command to add the option to.
 * @param extra - Additional format names beyond the defaults (table, tsv, json, yaml).
 * @returns The command (for chaining).
 */
function withOutputOption(cmd: Command, extra?: string[]): Command {
  const formats = ['table', 'tsv', 'json', 'yaml', ...(extra ?? [])];
  return cmd.option("-o, --output <format>", `Output format: ${formats.join(', ')}`, "table");
}

program
  .name("scope-mt")
  .description("Scope — AI coding agent benchmarking CLI")
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
  .option("--mcp-servers <slugs...>", "MCP server slugs to use for this run")
  .option("--skills <slugs...>", "Skill slugs to use for this run (e.g. vercel-labs/agent-skills/my-skill)")
  .option("--extensions <ids...>", "VS Code extension IDs to install for this run (e.g. ms-python.python)")
  .option("--agent-version <version>", "Agent version to target (e.g. copilot-0.0.415); defaults to latest active")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .option("--no-stream", "Don't stream logs, just submit")
  .action(async (options) => {
    const { scenario, persona, traits, worker, url, stream, maxIterations, model, mcpServers: mcpServerSlugs, skills: skillSlugs, extensions: extensionIds, agentVersion } = options;

    try {
      // Resolve scenario + persona YAML if provided
      let message = options.message;
      let criteria = options.criteria;
      let personaInstructions: string | undefined;
      let personaObj: Record<string, unknown> | undefined;

      if (scenario) {
        const resolved = resolveScenarioAndPersona(scenario, persona, traits);
        // Scenario provides task and criteria (CLI flags override)
        if (!message) message = resolved.task;
        if (!criteria || criteria.length === 0) criteria = resolved.criteria;
        personaInstructions = resolved.personaInstructions;
        personaObj = resolved.persona;

        console.log(`${label('Scenario:')} ${value(scenario)}`);
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
      if (mcpServerSlugs && mcpServerSlugs.length > 0) {
        body.mcpServers = mcpServerSlugs;
      }
      if (skillSlugs && skillSlugs.length > 0) {
        body.skills = skillSlugs;
      }
      if (extensionIds && extensionIds.length > 0) {
        body.extensions = extensionIds;
      }
      if (agentVersion) {
        body.agentVersion = agentVersion;
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
      if (result.submissionId) console.log(`${label('Submission:')} ${value(result.submissionId)}`);
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

withOutputOption(
run
  .command("status")
  .description("Get status of a request")
  .requiredOption("-i, --id <id>", "Request ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const { id } = options;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/requests/${id}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error);
        process.exit(1);
      }

      const request = await response.json();

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'id', label: 'ID' },
          { key: 'workerType', label: 'Worker' },
          { key: 'status', label: 'Status' },
          { key: 'mode', label: 'Mode' },
          { key: 'createdAt', label: 'Created' },
          { key: 'completedAt', label: 'Completed' },
        ];
        console.log(formatData([request], fields, format));
        return;
      }

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

withOutputOption(
run
  .command("get")
  .description("Get full details of a run")
  .requiredOption("-i, --id <id>", "Run ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    await runGetAction({ id: options.id, url: options.url, output: options.output });
  });

run
  .command("logs")
  .description("Stream logs for a request")
  .requiredOption("-i, --id <id>", "Request ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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

withOutputOption(
run
  .command("list")
  .description("List all requests")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .option("-w, --worker <worker>", "Filter by worker")
  .option("--submission-id <id>", "Filter by submission ID")
  .option("--include-deleted", "Include soft-deleted runs")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      let url = `${normalizeUrl(options.url)}/api/v1/requests`;
      const params = new URLSearchParams();
      if (options.worker) {
        params.set("worker", options.worker);
      }
      if (options.submissionId) {
        params.set("submissionId", options.submissionId);
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
              const o = req.outcome;
              return o === 'succeeded' ? successText(s) : o === 'failed' || o === 'finished' ? errorText(s) : value(s);
            },
          },
          { key: 'submissionId', label: 'Submission',
            formatter: (req: any) => req.submissionId ? req.submissionId.substring(0, 8) : '–',
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
  .option("-c, --count <count>", "Number of requests to send to each coder", "5")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    const { id, url } = options;
    const shouldExtract = options.extract || !!options.dir;
    const downloadDir = process.env.SCOPE_MT_DOWNLOAD_OUTPUT_DIR;
    const defaultFile = downloadDir ? join(downloadDir, `${id}.tar.gz`) : `${id}.tar.gz`;
    const outputFile = options.output || defaultFile;

    try {
      // Step 1: Fetch request document (lightweight — for metadata display)
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

      // Step 2: Download the full archive from the server
      console.log(`${label('Downloading archive')}...`);
      const archiveResp = await fetch(`${normalizeUrl(url)}/api/v1/requests/${id}/archive`);
      if (!archiveResp.ok || !archiveResp.body) {
        const error = await archiveResp.json().catch(() => ({ error: archiveResp.statusText }));
        console.error(errorText("Error downloading archive:"), error);
        process.exit(1);
      }

      const outputPath = resolve(outputFile);
      mkdirSync(dirname(outputPath), { recursive: true });
      const fileStream = createWriteStream(outputPath);
      await pipeline(Readable.fromWeb(archiveResp.body as any), fileStream);
      console.log(`${successText('Archive:')} ${value(outputPath)}`);

      // Step 3: Optionally extract
      if (shouldExtract) {
        const extractDir = options.dir || downloadDir || ".";
        mkdirSync(extractDir, { recursive: true });
        execSync(`tar xzf "${outputPath}" -C "${extractDir}"`, { stdio: "pipe" });

        // Extract nested iteration-*.tar.gz files into iteration-N/ directories
        const runExtractDir = join(extractDir, id);
        if (existsSync(runExtractDir)) {
          const nestedArchives = readdirSync(runExtractDir).filter(f => f.startsWith("iteration-") && f.endsWith(".tar.gz"));
          for (const archive of nestedArchives) {
            const iterName = archive.replace(".tar.gz", "");
            const iterDir = join(runExtractDir, iterName);
            mkdirSync(iterDir, { recursive: true });
            execSync(`tar xzf "${join(runExtractDir, archive)}" -C "${iterDir}"`, { stdio: "pipe" });
            rmSync(join(runExtractDir, archive), { force: true });
          }
        }

        rmSync(outputPath, { force: true });
        console.log(`${successText('Extracted to:')} ${value(resolve(extractDir, id))}`);
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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

withOutputOption(
criteria
  .command("list")
  .description("List all criteria")
  .option("-q, --query <search>", "Filter by ID or prompt text")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
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

withOutputOption(
criteria
  .command("get")
  .description("Get details of a single criterion")
  .requiredOption("-i, --id <id>", "Criterion ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
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

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'id', label: 'ID' },
          { key: 'prompt', label: 'Prompt' },
          { key: 'dependsOn', label: 'Depends On', formatter: (item: any) => (item.dependsOn ?? []).join(', ') || '(none)' },
          { key: 'dependents', label: 'Dependents', formatter: (item: any) => (item.dependents ?? []).join(', ') || '(none)' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([c], fields, format));
        return;
      }

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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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

withOutputOption(
criteria
  .command("graph")
  .description("Display the criteria dependency graph as ASCII")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
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

      if (isMachineReadable(format)) {
        console.log(format === 'json' ? JSON.stringify(graph, null, 2) : format === 'yaml' ? yamlStringify(graph).trimEnd() : JSON.stringify(graph));
        return;
      }

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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .description("Manage prompt features (CRUD, import, extract)")
  .action(() => {
    promptFeature.help();
  });

configureHelp(promptFeature);

withOutputOption(
promptFeature
  .command("list")
  .description("List all prompt features")
  .option("-q, --query <search>", "Filter by ID or prompt text")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
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

      const items = await response.json() as Array<{ id: string; prompt: string }>;
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

withOutputOption(
promptFeature
  .command("get")
  .description("Get details of a single prompt feature")
  .requiredOption("-i, --id <id>", "Prompt feature ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/prompt-features/${options.id}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const f = await response.json() as {
        id: string; prompt: string;
        createdAt: string; updatedAt?: string;
      };

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'id', label: 'ID' },
          { key: 'prompt', label: 'Prompt' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([f], fields, format));
        return;
      }

      console.log(`${label('ID:')}        ${value(f.id)}`);
      console.log(`${label('Prompt:')}`);
      for (const line of f.prompt.trim().split('\n')) {
        console.log(`  ${line}`);
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {
        id: options.id,
        prompt: options.prompt,
      };

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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {};
      if (options.prompt !== undefined) body.prompt = options.prompt;

      if (Object.keys(body).length === 0) {
        console.error(errorText("Error: provide --prompt"));
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
  .description("Delete a prompt feature (soft-delete)")
  .requiredOption("-i, --id <id>", "Prompt feature ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/prompt-features/${options.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      console.log(`${successText('Deleted prompt feature')} ${value(options.id)}`);
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
        console.log(`  ${value(f.id)}`);
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

withOutputOption(
promptFeature
  .command("extract")
  .description("Extract prompt features from a task text or scenario file (uses task prompt pipeline)")
  .option("-t, --task <text>", "Task text to analyze")
  .option("-s, --scenario <path>", "Path to scenario YAML file (uses its task text)")
  .option("--model <model>", "LLM model to use for extraction")
  .option("--force", "Force re-extraction even if already extracted")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
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
        if (!isMachineReadable(format)) console.log(`${label('Scenario:')} ${value(basename(absPath))}`);
      }

      if (!taskText) {
        console.error(errorText("Error: provide --task or --scenario"));
        process.exit(1);
      }

      // Step 1: Register task prompt (idempotent)
      if (!isMachineReadable(format)) console.log(`${label('Registering task prompt...')}`);
      const createResponse = await fetch(`${normalizeUrl(options.url)}/api/v1/task-prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: taskText }),
      });

      if (!createResponse.ok) {
        const error = await createResponse.json();
        console.error(errorText("Error creating task prompt:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const taskPromptDoc = await createResponse.json() as { _id: string };
      if (!isMachineReadable(format)) console.log(`${label('Task prompt ID:')} ${value(taskPromptDoc._id)}`);

      // Step 2: Extract features on the task prompt entity
      if (!isMachineReadable(format)) console.log(`${label('Extracting prompt features...')}`);

      const qs = options.force ? "?force=true" : "";
      const body: Record<string, unknown> = {};
      if (options.model) body.model = options.model;

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/task-prompts/${encodeURIComponent(taskPromptDoc._id)}/extract-features${qs}`, {
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
        features: Array<{ featureId: string; detected: boolean; evaluated: boolean }>;
        cached: boolean;
      };

      if (isMachineReadable(format)) {
        console.log(format === 'json' ? JSON.stringify(extraction, null, 2) : format === 'yaml' ? yamlStringify(extraction).trimEnd() : JSON.stringify(extraction));
        return;
      }

      if (extraction.cached) {
        console.log(dimTimestamp('(cached — use --force to re-extract)'));
      }

      const detected = extraction.features.filter(r => r.detected);
      const notDetected = extraction.features.filter(r => !r.detected && r.evaluated);
      const skipped = extraction.features.filter(r => !r.evaluated);

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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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

withOutputOption(
report
  .command("get")
  .description("Get a report by ID")
  .requiredOption("-i, --id <reportId>", "Report ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
, ['markdown'])
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
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

      if (format === 'markdown') {
        console.log(report.content ?? '');
        return;
      }

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'id', label: 'ID' },
          { key: 'requestId', label: 'Run' },
          { key: 'status', label: 'Status' },
          { key: 'reporter', label: 'Reporter', formatter: (r: any) => r.reporter ? `${r.reporter.name} (${r.reporter.agentId}@${r.reporter.agentVersion})` : '' },
          { key: 'model', label: 'Model', formatter: (r: any) => r.reporter?.model || '' },
          { key: 'content', label: 'Content', formatter: (r: any) => r.content || '' },
          { key: 'error', label: 'Error', formatter: (r: any) => r.error || '' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([report], fields, format));
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

withOutputOption(
report
  .command("list")
  .description("List all reports (optionally filter by run)")
  .option("-r, --run <requestId>", "Filter by run ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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

// ─── Report Template management ──────────────────────────────────────────────

const reportTemplate = program
  .command("report-template")
  .description("Manage report templates (CRUD, import)")
  .action(() => {
    reportTemplate.help();
  });

configureHelp(reportTemplate);

reportTemplate
  .command("models")
  .description("List models available for report generation")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/report-templates/available-models`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const models = await response.json() as Array<{ modelId: string }>;
      if (models.length === 0) {
        console.log(warnBanner("No models available. Run the copilot model scanner first."));
        return;
      }
      console.log(label(`Available models for report generation:\n`));
      for (const m of models) {
        console.log(`  ${value(m.modelId)}`);
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
reportTemplate
  .command("list")
  .description("List all report templates")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/report-templates`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const items = await response.json() as Array<{
        id: string; name: string; description?: string;
        userPrompt: string; systemPrompt?: { mode: string; content: string };
        trigger?: { type: string; [k: string]: unknown };
        createdAt: string;
      }>;

      if (items.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No report templates found."));
        return;
      }

      if (!isMachineReadable(format)) {
        console.log(label(`Found ${items.length} report templates:\n`));
      }

      const displayFields: DisplayField[] = [
        { key: 'id', label: 'ID', tableFormatter: (t: any) => value(t.id) },
        { key: 'name', label: 'Name' },
        { key: 'trigger', label: 'Trigger', formatter: (t: any) => t.trigger?.type ?? 'always' },
        { key: 'systemPrompt', label: 'SysPrompt', formatter: (t: any) => t.systemPrompt ? t.systemPrompt.mode : '—' },
        { key: 'userPrompt', label: 'UserPrompt', formatter: (t: any) => {
          const p = t.userPrompt.replace(/\n/g, ' ');
          return p.length > 50 ? p.substring(0, 50) + '…' : p;
        }, tableFormatter: (t: any) => {
          const p = t.userPrompt.replace(/\n/g, ' ');
          const truncated = p.length > 50 ? p.substring(0, 50) + '…' : p;
          return dimTimestamp(truncated);
        }},
      ];

      console.log(formatData(items, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
reportTemplate
  .command("get")
  .description("Get details of a single report template")
  .requiredOption("-i, --id <id>", "Report template ID (slug)")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/report-templates/${options.id}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const t = await response.json() as {
        id: string; name: string; description?: string;
        userPrompt: string; systemPrompt?: { mode: string; content: string };
        trigger?: { type: string; [k: string]: unknown };
        createdAt: string; updatedAt?: string;
      };

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'id', label: 'ID' },
          { key: 'name', label: 'Name' },
          { key: 'description', label: 'Description', formatter: (item: any) => item.description || '' },
          { key: 'trigger', label: 'Trigger', formatter: (item: any) => item.trigger?.type ?? 'always' },
          { key: 'userPrompt', label: 'User Prompt' },
          { key: 'systemPrompt', label: 'System Prompt', formatter: (item: any) => item.systemPrompt ? `${item.systemPrompt.mode}: ${item.systemPrompt.content}` : '' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([t], fields, format));
        return;
      }

      console.log(`${label('ID:')}          ${value(t.id)}`);
      console.log(`${label('Name:')}        ${t.name}`);
      if (t.description) console.log(`${label('Description:')} ${t.description}`);
      console.log(`${label('Trigger:')}     ${value(t.trigger?.type ?? 'always')}`);
      if (t.trigger && t.trigger.type !== 'always') {
        console.log(`${label('Trigger cfg:')} ${dimTimestamp(JSON.stringify(t.trigger))}`);
      }
      console.log(`${label('User prompt:')}`);
      for (const line of t.userPrompt.trim().split('\n')) {
        console.log(`  ${line}`);
      }
      if (t.systemPrompt) {
        console.log(`${label('Sys prompt:')}  ${value(t.systemPrompt.mode)}`);
        for (const line of t.systemPrompt.content.trim().split('\n')) {
          console.log(`  ${line}`);
        }
      }
      console.log(`${label('Created:')}     ${value(t.createdAt)}`);
      if (t.updatedAt) console.log(`${label('Updated:')}     ${value(t.updatedAt)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

reportTemplate
  .command("create")
  .description("Create a new report template")
  .requiredOption("--id <id>", "Template ID slug (lowercase, hyphens)")
  .requiredOption("--name <name>", "Display name for the template")
  .requiredOption("--user-prompt <prompt>", "User prompt (the instruction for the report agent)")
  .option("--description <desc>", "Optional description")
  .option("--system-prompt-mode <mode>", "System prompt mode: append or override")
  .option("--system-prompt-content <content>", "System prompt content")
  .option("--model <model>", "LLM model to use for this template (overrides global REPORT_MODEL)")
  .option("--timeout-ms <ms>", "Session timeout in milliseconds (overrides global SESSION_TIMEOUT_MS)")
  .option("--trigger-type <type>", "Trigger type: always, criteria, taskPrompt, promptFeature")
  .option("--trigger-ids <ids...>", "Trigger IDs (criteria IDs, task prompt IDs, or feature IDs)")
  .option("--trigger-match <match>", "Trigger match mode: any or all (default: all)")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {
        id: options.id,
        name: options.name,
        userPrompt: options.userPrompt,
      };
      if (options.description) body.description = options.description;
      if (options.model) body.model = options.model;
      if (options.timeoutMs) body.timeoutMs = Number(options.timeoutMs);
      if (options.systemPromptMode && options.systemPromptContent) {
        body.systemPrompt = {
          mode: options.systemPromptMode,
          content: options.systemPromptContent,
        };
      }
      if (options.triggerType) {
        const trigger: Record<string, unknown> = { type: options.triggerType };
        if (options.triggerType === 'criteria' && options.triggerIds) {
          trigger.criteriaIds = options.triggerIds;
          if (options.triggerMatch) trigger.match = options.triggerMatch;
        } else if (options.triggerType === 'taskPrompt' && options.triggerIds) {
          trigger.taskPromptIds = options.triggerIds;
        } else if (options.triggerType === 'promptFeature' && options.triggerIds) {
          trigger.featureIds = options.triggerIds;
          if (options.triggerMatch) trigger.match = options.triggerMatch;
        }
        body.trigger = trigger;
      }

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/report-templates`, {
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
      console.log(`${successText('Created report template')} ${value(created.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

reportTemplate
  .command("update")
  .description("Update an existing report template")
  .requiredOption("-i, --id <id>", "Report template ID (slug)")
  .option("--name <name>", "New display name")
  .option("--description <desc>", "New description")
  .option("--user-prompt <prompt>", "New user prompt")
  .option("--system-prompt-mode <mode>", "System prompt mode: append or override")
  .option("--system-prompt-content <content>", "System prompt content")
  .option("--model <model>", "LLM model to use for this template (overrides global REPORT_MODEL)")
  .option("--timeout-ms <ms>", "Session timeout in milliseconds (overrides global SESSION_TIMEOUT_MS)")
  .option("--trigger-type <type>", "New trigger type: always, criteria, taskPrompt, promptFeature")
  .option("--trigger-ids <ids...>", "Trigger IDs")
  .option("--trigger-match <match>", "Trigger match mode: any or all")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {};
      if (options.name !== undefined) body.name = options.name;
      if (options.description !== undefined) body.description = options.description;
      if (options.userPrompt !== undefined) body.userPrompt = options.userPrompt;
      if (options.model !== undefined) body.model = options.model;
      if (options.timeoutMs !== undefined) body.timeoutMs = Number(options.timeoutMs);
      if (options.systemPromptMode && options.systemPromptContent) {
        body.systemPrompt = {
          mode: options.systemPromptMode,
          content: options.systemPromptContent,
        };
      }
      if (options.triggerType) {
        const trigger: Record<string, unknown> = { type: options.triggerType };
        if (options.triggerType === 'criteria' && options.triggerIds) {
          trigger.criteriaIds = options.triggerIds;
          if (options.triggerMatch) trigger.match = options.triggerMatch;
        } else if (options.triggerType === 'taskPrompt' && options.triggerIds) {
          trigger.taskPromptIds = options.triggerIds;
        } else if (options.triggerType === 'promptFeature' && options.triggerIds) {
          trigger.featureIds = options.triggerIds;
          if (options.triggerMatch) trigger.match = options.triggerMatch;
        }
        body.trigger = trigger;
      }

      if (Object.keys(body).length === 0) {
        console.error(errorText("Error: provide at least one field to update"));
        process.exit(1);
      }

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/report-templates/${options.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      console.log(`${successText('Updated report template')} ${value(options.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

reportTemplate
  .command("delete")
  .description("Delete a report template (soft-delete)")
  .requiredOption("-i, --id <id>", "Report template ID (slug)")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/report-templates/${options.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      console.log(`${successText('Deleted report template')} ${value(options.id)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

reportTemplate
  .command("import")
  .description("Import report templates from a YAML file (upsert via create/update)")
  .argument("<path>", "Path to a .yaml file or directory of .yaml files")
  .option("--dry-run", "Preview what would be imported without sending to API")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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

      const allTemplates: Array<Record<string, unknown>> = [];
      const parseErrors: string[] = [];

      for (const file of yamlFiles) {
        const content = readFileSync(file, 'utf-8');
        const fname = basename(file);

        try {
          const docs = parseAllDocuments(content);
          for (let docIdx = 0; docIdx < docs.length; docIdx++) {
            const doc = docs[docIdx].toJSON();
            if (!doc || typeof doc !== 'object') continue;

            const template = mapYamlReportTemplate(doc, fname, docIdx);
            if (template) {
              allTemplates.push(template);
            } else {
              parseErrors.push(`${fname}${docs.length > 1 ? ` (doc ${docIdx + 1})` : ''}: missing id, name, or user_prompt`);
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

      if (allTemplates.length === 0) {
        console.error(errorText('No valid report templates found to import.'));
        process.exit(1);
      }

      console.log(`\n${label('Parsed:')} ${value(String(allTemplates.length))} report templates`);
      for (const t of allTemplates) {
        const triggerStr = t.trigger ? ` ${dimTimestamp(`(trigger: ${(t.trigger as any).type})`)}` : '';
        console.log(`  ${value(t.id as string)} — ${t.name}${triggerStr}`);
      }

      if (options.dryRun) {
        console.log(`\n${warnBanner('Dry run — no changes made.')}`);
        return;
      }

      console.log();
      let created = 0;
      let updated = 0;
      const errors: string[] = [];

      for (const t of allTemplates) {
        const id = t.id as string;
        // Try to GET existing
        const getResp = await fetch(`${normalizeUrl(options.url)}/api/v1/report-templates/${id}`);
        if (getResp.ok) {
          // Update
          const { id: _id, ...updateBody } = t;
          const resp = await fetch(`${normalizeUrl(options.url)}/api/v1/report-templates/${id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updateBody),
          });
          if (resp.ok) {
            updated++;
            console.log(`  ${dimTimestamp('updated')} ${value(id)}`);
          } else {
            const err = await resp.json();
            errors.push(`${id}: ${err.error || JSON.stringify(err)}`);
          }
        } else if (getResp.status === 404) {
          // Create
          const resp = await fetch(`${normalizeUrl(options.url)}/api/v1/report-templates`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(t),
          });
          if (resp.ok) {
            created++;
            console.log(`  ${successText('created')} ${value(id)}`);
          } else {
            const err = await resp.json();
            errors.push(`${id}: ${err.error || JSON.stringify(err)}`);
          }
        } else {
          errors.push(`${id}: failed to check existence (status ${getResp.status})`);
        }
      }

      console.log(`\n${successText('Import complete:')} ${value(String(created))} created, ${value(String(updated))} updated`);
      if (errors.length > 0) {
        console.log(`\n${warnBanner('Errors:')}`);
        for (const err of errors) {
          console.log(`  ${errorText('⚠')} ${err}`);
        }
      }
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Map a parsed YAML object to a report template API payload.
 * Handles snake_case → camelCase conversion for YAML convention.
 */
function mapYamlReportTemplate(
  doc: Record<string, unknown>,
  _filename: string,
  _docIndex: number
): Record<string, unknown> | null {
  const id = doc.id as string | undefined;
  const name = doc.name as string | undefined;
  const userPrompt = (doc.user_prompt ?? doc.userPrompt) as string | undefined;
  if (!id || !name || !userPrompt) return null;

  const result: Record<string, unknown> = {
    id: id.trim(),
    name: name.trim(),
    userPrompt: userPrompt.trim(),
  };

  const description = doc.description as string | undefined;
  if (description) result.description = description.trim();

  const model = doc.model as string | undefined;
  if (model) result.model = model.trim();

  const timeoutMs = (doc.timeout_ms ?? doc.timeoutMs) as number | undefined;
  if (timeoutMs) result.timeoutMs = Number(timeoutMs);

  // System prompt: support snake_case YAML
  const sysCfg = (doc.system_prompt ?? doc.systemPrompt) as Record<string, unknown> | undefined;
  if (sysCfg && sysCfg.mode && sysCfg.content) {
    result.systemPrompt = {
      mode: String(sysCfg.mode).trim(),
      content: String(sysCfg.content).trim(),
    };
  }

  // Trigger
  const triggerCfg = doc.trigger as Record<string, unknown> | undefined;
  if (triggerCfg && triggerCfg.type) {
    const trigger: Record<string, unknown> = { type: String(triggerCfg.type).trim() };
    const triggerType = trigger.type as string;

    if (triggerType === 'criteria') {
      const ids = (triggerCfg.criteria_ids ?? triggerCfg.criteriaIds) as string[] | undefined;
      if (Array.isArray(ids)) trigger.criteriaIds = ids.map(s => String(s).trim());
      if (triggerCfg.match) trigger.match = String(triggerCfg.match).trim();
    } else if (triggerType === 'taskPrompt') {
      const ids = (triggerCfg.task_prompt_ids ?? triggerCfg.taskPromptIds) as string[] | undefined;
      if (Array.isArray(ids)) trigger.taskPromptIds = ids.map(s => String(s).trim());
    } else if (triggerType === 'promptFeature') {
      const ids = (triggerCfg.feature_ids ?? triggerCfg.featureIds) as string[] | undefined;
      if (Array.isArray(ids)) trigger.featureIds = ids.map(s => String(s).trim());
      if (triggerCfg.match) trigger.match = String(triggerCfg.match).trim();
    }

    result.trigger = trigger;
  }

  return result;
}

// ─── Agent management ────────────────────────────────────────────────────────

const agent = program
  .command("agent")
  .description("Manage coding agent definitions and their supported models")
  .action(() => {
    agent.help();
  });

configureHelp(agent);

withOutputOption(
agent
  .command("list")
  .description("List all coding agents")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
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

withOutputOption(
agent
  .command("get")
  .description("Get details of a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
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

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: '_id', label: 'ID' },
          { key: 'name', label: 'Name' },
          { key: 'description', label: 'Description', formatter: (a: any) => a.description || '' },
          { key: 'supportedModels', label: 'Supported Models', formatter: (a: any) => (a.supportedModels || []).join(', ') },
          { key: 'defaultModel', label: 'Default Model', formatter: (a: any) => a.defaultModel || '' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([agentDoc], fields, format));
        return;
      }

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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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

withOutputOption(
agentModel
  .command("list")
  .description("List supported models for a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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

// ─── Agent version sub-commands ──────────────────────────────────────────────

const agentVersion = agent
  .command("version")
  .description("Manage agent versions")
  .action(() => {
    agentVersion.help();
  });

configureHelp(agentVersion);

withOutputOption(
agentVersion
  .command("list")
  .description("List versions for a coding agent")
  .requiredOption("-i, --id <id>", "Agent ID")
  .option("--status <status>", "Filter by status (active, retired)")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const params = options.status ? `?status=${encodeURIComponent(options.status)}` : '';
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/agents/${encodeURIComponent(options.id)}/versions${params}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const versions = await response.json() as Array<{
        agentVersion: string;
        workerVersion: string;
        components: Record<string, string>;
        queueName: string;
        status: string;
        createdAt: string;
      }>;
      if (versions.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner(`No versions found for agent ${options.id}.`));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`${versions.length} version(s) for ${options.id}:\n`));
      }
      const displayFields: DisplayField[] = [
        { key: 'agentVersion', label: 'Version', tableFormatter: (v: any) => value(v.agentVersion) },
        { key: 'status', label: 'Status', formatter: (v: any) => v.status },
        { key: 'components', label: 'Components', formatter: (v: any) => Object.entries(v.components || {}).map(([k, val]) => `${k}=${val}`).join(', ') },
        { key: 'queueName', label: 'Queue' },
        { key: 'createdAt', label: 'Created', formatter: (v: any) => new Date(v.createdAt).toLocaleString() },
      ];
      console.log(formatData(versions, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ─── MCP server management ──────────────────────────────────────────────────

const mcp = program
  .command("mcp")
  .description("Manage MCP (Model Context Protocol) resources")
  .action(() => {
    mcp.help();
  });

configureHelp(mcp);

/** Parse KEY=VALUE strings into a Record, exiting on bad format */
function parseEnvPairs(pairs: string[]): Record<string, string> {
  return pairs.reduce((acc: Record<string, string>, pair: string) => {
    const idx = pair.indexOf('=');
    if (idx === -1) {
      console.error(errorText(`Invalid env format: "${pair}". Expected KEY=VALUE`));
      process.exit(1);
    }
    acc[pair.substring(0, idx)] = pair.substring(idx + 1);
    return acc;
  }, {});
}

/** Parse name:value strings into header objects, exiting on bad format */
function parseHeaderPairs(pairs: string[]): { name: string; value: string }[] {
  return pairs.map((h: string) => {
    const idx = h.indexOf(':');
    if (idx === -1) {
      console.error(errorText(`Invalid header format: "${h}". Expected name:value`));
      process.exit(1);
    }
    return { name: h.substring(0, idx).trim(), value: h.substring(idx + 1).trim() };
  });
}

const mcpServer = mcp
  .command("server")
  .description("Manage remote MCP servers (SSE and streamable HTTP)")
  .action(() => {
    mcpServer.help();
  });

configureHelp(mcpServer);

withOutputOption(
mcpServer
  .command("list")
  .description("List all MCP servers")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/mcp/servers`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const servers = await response.json() as Array<{ _id: string; name: string; type: string; url: string; description?: string }>;
      if (servers.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No MCP servers found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${servers.length} MCP server(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: '_id', label: 'Slug', tableFormatter: (s: any) => value(s._id) },
        { key: 'name', label: 'Name' },
        { key: 'type', label: 'Type' },
        { key: 'url', label: 'URL' },
        { key: 'description', label: 'Description', formatter: (s: any) => s.description || '—' },
      ];
      console.log(formatData(servers, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
mcpServer
  .command("get")
  .description("Get details of an MCP server")
  .requiredOption("-i, --id <id>", "MCP server slug")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/mcp/servers/${encodeURIComponent(options.id)}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const server = await response.json();

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: '_id', label: 'Slug' },
          { key: 'name', label: 'Name' },
          { key: 'type', label: 'Type' },
          { key: 'url', label: 'URL' },
          { key: 'description', label: 'Description', formatter: (s: any) => s.description || '' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([server], fields, format));
        return;
      }

      console.log(`${label('Slug:')} ${value(server._id)}`);
      console.log(`${label('Name:')} ${value(server.name)}`);
      console.log(`${label('Type:')} ${value(server.type)}`);
      if (server.type === 'stdio') {
        console.log(`${label('Command:')} ${value(server.command)}`);
        if (server.args && server.args.length > 0) {
          console.log(`${label('Args:')} ${value(server.args.join(' '))}`);
        }
        if (server.env && Object.keys(server.env).length > 0) {
          console.log(`${label('Env:')}`);
          for (const [k, v] of Object.entries(server.env)) {
            console.log(`  ${k}=${v}`);
          }
        }
      } else {
        console.log(`${label('URL:')} ${value(server.url)}`);
        if (server.headers && server.headers.length > 0) {
          console.log(`${label('Headers:')}`);
          for (const h of server.headers) {
            console.log(`  ${h.name}: ${h.value}`);
          }
        }
      }
      if (server.description) console.log(`${label('Description:')} ${server.description}`);
      console.log(`${label('Created:')} ${new Date(server.createdAt).toLocaleString()}`);
      if (server.updatedAt) console.log(`${label('Updated:')} ${new Date(server.updatedAt).toLocaleString()}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

mcpServer
  .command("create")
  .description("Create a new MCP server")
  .requiredOption("--id <slug>", "Slug identifier (lowercase, hyphens allowed)")
  .requiredOption("--name <name>", "Display name")
  .requiredOption("--type <type>", "Transport type (sse, http, or stdio)")
  .option("--url <url>", "Server URL (required for sse/http)")
  .option("--command <command>", "Executable to spawn (required for stdio)")
  .option("--args <args>", "Space-separated CLI arguments for stdio command")
  .option("--env <env...>", "Environment variables in KEY=VALUE format (repeatable)")
  .option("--description <desc>", "Description")
  .option("--header <header...>", "Headers in name:value format (repeatable)")
  .option("-u, --api-url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const isStdio = options.type === "stdio";

      if (isStdio && !options.command) {
        console.error(errorText("Error: --command is required for stdio transport"));
        process.exit(1);
      }
      if (!isStdio && !options.url) {
        console.error(errorText("Error: --url is required for sse/http transport"));
        process.exit(1);
      }

      const headers = options.header ? parseHeaderPairs(options.header) : undefined;
      const env = options.env ? parseEnvPairs(options.env) : undefined;

      const body: Record<string, unknown> = {
        _id: options.id,
        name: options.name,
        type: options.type,
      };
      if (isStdio) {
        body.command = options.command;
        if (options.args) body.args = options.args.trim().split(/\s+/);
        if (env && Object.keys(env).length > 0) body.env = env;
      } else {
        body.url = options.url;
        if (headers && headers.length > 0) body.headers = headers;
      }
      if (options.description) body.description = options.description;

      const response = await fetch(`${normalizeUrl(options.apiUrl)}/api/v1/mcp/servers`, {
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
      console.log(successText(`MCP server "${created._id}" created.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

mcpServer
  .command("update")
  .description("Update an MCP server")
  .requiredOption("-i, --id <id>", "MCP server slug")
  .option("--name <name>", "Display name")
  .option("--type <type>", "Transport type (sse, http, or stdio)")
  .option("--url <url>", "Server URL")
  .option("--command <command>", "Executable to spawn (stdio)")
  .option("--args <args>", "Space-separated CLI arguments for stdio command")
  .option("--env <env...>", "Environment variables in KEY=VALUE format (replaces all env vars)")
  .option("--description <desc>", "Description")
  .option("--header <header...>", "Headers in name:value format (replaces all headers)")
  .option("-u, --api-url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {};
      if (options.name) body.name = options.name;
      if (options.type) body.type = options.type;
      if (options.url) body.url = options.url;
      if (options.command) body.command = options.command;
      if (options.args) body.args = options.args.trim().split(/\s+/);
      if (options.env) body.env = parseEnvPairs(options.env);
      if (options.description) body.description = options.description;
      if (options.header) body.headers = parseHeaderPairs(options.header);
      if (Object.keys(body).length === 0) {
        console.error(errorText("Error: provide at least one field to update"));
        process.exit(1);
      }
      const response = await fetch(`${normalizeUrl(options.apiUrl)}/api/v1/mcp/servers/${encodeURIComponent(options.id)}`, {
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
      console.log(successText(`MCP server "${updated._id}" updated.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

mcpServer
  .command("delete")
  .description("Delete an MCP server (soft-delete)")
  .requiredOption("-i, --id <id>", "MCP server slug")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/mcp/servers/${encodeURIComponent(options.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`MCP server "${options.id}" deleted.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ─── Skill management ────────────────────────────────────────────────────────

const skill = program
  .command("skill")
  .description("Manage agent skills (Agent Skills Specification)")
  .action(() => {
    skill.help();
  });

configureHelp(skill);

withOutputOption(
skill
  .command("list")
  .description("List all imported skills")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/skills`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const skills = await response.json() as Array<{ _id: string; name: string; source: string; description?: string; origin: string }>;
      if (skills.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No skills found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${skills.length} skill(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: '_id', label: 'Slug', tableFormatter: (s: any) => value(s._id) },
        { key: 'name', label: 'Name' },
        { key: 'source', label: 'Source' },
        { key: 'origin', label: 'Origin' },
        { key: 'description', label: 'Description', formatter: (s: any) => s.description || '—' },
      ];
      console.log(formatData(skills, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
skill
  .command("search")
  .description("Search skills (internal + skills.sh registry)")
  .requiredOption("-q, --query <query>", "Search query")
  .option("--limit <number>", "Maximum results", parseInt)
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const params = new URLSearchParams({ q: options.query });
      if (options.limit) params.set('limit', String(options.limit));
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/skills/search?${params}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const results = await response.json() as Array<{ id: string; name: string; source: string; description?: string; internal: boolean; installs?: number }>;
      if (results.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No skills found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${results.length} result(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: 'id', label: 'Slug', tableFormatter: (s: any) => value(s.id) },
        { key: 'name', label: 'Name' },
        { key: 'source', label: 'Source' },
        { key: 'internal', label: 'Imported', formatter: (s: any) => s.internal ? 'Yes' : 'No' },
        { key: 'installs', label: 'Installs', formatter: (s: any) => s.installs != null ? String(s.installs) : '—' },
        { key: 'description', label: 'Description', formatter: (s: any) => s.description || '—' },
      ];
      console.log(formatData(results, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
skill
  .command("get")
  .description("Get details of a skill")
  .requiredOption("-i, --id <id>", "Skill slug (e.g. vercel-labs/agent-skills/my-skill)")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/skills/${options.id}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const s = await response.json();

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: '_id', label: 'Slug' },
          { key: 'name', label: 'Name' },
          { key: 'source', label: 'Source' },
          { key: 'skillName', label: 'Skill Name' },
          { key: 'origin', label: 'Origin' },
          { key: 'description', label: 'Description', formatter: (sk: any) => sk.description || '' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([s], fields, format));
        return;
      }

      console.log(`${label('Slug:')} ${value(s._id)}`);
      console.log(`${label('Name:')} ${value(s.name)}`);
      console.log(`${label('Source:')} ${value(s.source)}`);
      console.log(`${label('Skill Name:')} ${value(s.skillName)}`);
      console.log(`${label('Origin:')} ${value(s.origin)}`);
      if (s.description) console.log(`${label('Description:')} ${s.description}`);
      console.log(`${label('Created:')} ${new Date(s.createdAt).toLocaleString()}`);
      if (s.updatedAt) console.log(`${label('Updated:')} ${new Date(s.updatedAt).toLocaleString()}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

skill
  .command("import")
  .description("Import a skill from a GitHub repository")
  .requiredOption("--source <source>", "GitHub repo (e.g. vercel-labs/agent-skills)")
  .requiredOption("--skill-name <name>", "Skill name within the repo")
  .requiredOption("--name <displayName>", "Display name")
  .option("--description <desc>", "Description")
  .option("--origin <origin>", "Origin: skills-sh or manual", "manual")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {
        source: options.source,
        skillName: options.skillName,
        name: options.name,
        origin: options.origin,
      };
      if (options.description) body.description = options.description;

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/skills`, {
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
      console.log(successText(`Skill "${created._id}" imported.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

skill
  .command("delete")
  .description("Delete a skill (soft-delete)")
  .requiredOption("-i, --id <id>", "Skill slug")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/skills/${options.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Skill "${options.id}" deleted.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
skill
  .command("resolve")
  .description("Resolve a skill from GitHub (fetch latest version and create a revision)")
  .requiredOption("-i, --id <id>", "Skill slug")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/skills/${options.id}/resolve`, {
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const revision = await response.json();

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'ref', label: 'Ref' },
          { key: 'commitHash', label: 'Commit' },
          { key: 'description', label: 'Description', formatter: (r: any) => r.description || '' },
          { key: 'archiveUrl', label: 'Archive URL', formatter: (r: any) => r.archiveUrl || '' },
        ];
        console.log(formatData([revision], fields, format));
        return;
      }

      console.log(successText(`Skill resolved to revision:`));
      console.log(`${label('Ref:')} ${value(revision.ref)}`);
      console.log(`${label('Commit:')} ${value(revision.commitHash)}`);
      console.log(`${label('Description:')} ${revision.description || '—'}`);
      if (revision.archiveUrl) console.log(`${label('Archive:')} ${value(revision.archiveUrl)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
skill
  .command("revisions")
  .description("List revisions for a skill")
  .requiredOption("-i, --id <id>", "Skill slug")
  .option("--limit <number>", "Maximum results", parseInt)
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const params = options.limit ? `?limit=${options.limit}` : '';
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/skills/${options.id}/revisions${params}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const revisions = await response.json() as Array<{ ref: string; commitHash: string; name: string; resolvedAt: string }>;
      if (revisions.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No revisions found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${revisions.length} revision(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: 'ref', label: 'Ref', tableFormatter: (r: any) => value(r.ref) },
        { key: 'commitHash', label: 'Commit', formatter: (r: any) => r.commitHash.substring(0, 8) },
        { key: 'name', label: 'Name' },
        { key: 'resolvedAt', label: 'Resolved', formatter: (r: any) => new Date(r.resolvedAt).toLocaleString() },
      ];
      console.log(formatData(revisions, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ─── Extension management ────────────────────────────────────────────────────

const extension = program
  .command("extension")
  .description("Manage VS Code extensions")
  .action(() => {
    extension.help();
  });

configureHelp(extension);

withOutputOption(
extension
  .command("list")
  .description("List all imported extensions")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/extensions`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const extensions = await response.json() as Array<{ _id: string; name: string; publisher: string; description?: string; version?: string; origin: string }>;
      if (extensions.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No extensions found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${extensions.length} extension(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: '_id', label: 'ID', tableFormatter: (e: any) => value(e._id) },
        { key: 'name', label: 'Name' },
        { key: 'publisher', label: 'Publisher' },
        { key: 'origin', label: 'Origin' },
        { key: 'description', label: 'Description', formatter: (e: any) => e.description || '—' },
      ];
      console.log(formatData(extensions, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
extension
  .command("search")
  .description("Search extensions (internal + VS Code marketplace)")
  .requiredOption("-q, --query <query>", "Search query")
  .option("--limit <number>", "Maximum results", parseInt)
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const params = new URLSearchParams({ q: options.query });
      if (options.limit) params.set('limit', String(options.limit));
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/extensions/search?${params}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const results = await response.json() as Array<{ id: string; name: string; publisher: string; description?: string; internal: boolean; version?: string }>;
      if (results.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No extensions found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${results.length} result(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: 'id', label: 'ID', tableFormatter: (e: any) => value(e.id) },
        { key: 'name', label: 'Name' },
        { key: 'publisher', label: 'Publisher' },
        { key: 'internal', label: 'Imported', formatter: (e: any) => e.internal ? 'Yes' : 'No' },
        { key: 'description', label: 'Description', formatter: (e: any) => e.description || '—' },
      ];
      console.log(formatData(results, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
extension
  .command("get")
  .description("Get details of an extension")
  .requiredOption("-i, --id <id>", "Extension ID (e.g. ms-python.python)")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/extensions/${options.id}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const e = await response.json();

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: '_id', label: 'ID' },
          { key: 'name', label: 'Name' },
          { key: 'publisher', label: 'Publisher' },
          { key: 'origin', label: 'Origin' },
          { key: 'description', label: 'Description', formatter: (ext: any) => ext.description || '' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([e], fields, format));
        return;
      }

      console.log(`${label('ID:')} ${value(e._id)}`);
      console.log(`${label('Name:')} ${value(e.name)}`);
      console.log(`${label('Publisher:')} ${value(e.publisher)}`);
      console.log(`${label('Origin:')} ${value(e.origin)}`);
      if (e.description) console.log(`${label('Description:')} ${e.description}`);
      console.log(`${label('Created:')} ${new Date(e.createdAt).toLocaleString()}`);
      if (e.updatedAt) console.log(`${label('Updated:')} ${new Date(e.updatedAt).toLocaleString()}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

extension
  .command("import")
  .description("Import a VS Code extension")
  .requiredOption("-i, --id <id>", "Extension ID (e.g. ms-python.python)")
  .requiredOption("--name <displayName>", "Display name")
  .option("--publisher <publisher>", "Publisher name (auto-extracted from ID if omitted)")
  .option("--description <desc>", "Description")
  .option("--origin <origin>", "Origin: marketplace or manual", "manual")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const publisher = options.publisher || options.id.split('.')[0];
      const body: Record<string, unknown> = {
        _id: options.id,
        publisher,
        name: options.name,
        origin: options.origin,
      };
      if (options.description) body.description = options.description;

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/extensions`, {
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
      console.log(successText(`Extension "${created._id}" imported.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

extension
  .command("delete")
  .description("Delete an extension (soft-delete)")
  .requiredOption("-i, --id <id>", "Extension ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/extensions/${options.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Extension "${options.id}" deleted.`));
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

withOutputOption(
insight
  .command("list")
  .description("List all insights")
  .option("-q, --query <query>", "Search by keyword")
  .option("--blocked", "Show only blocked insights")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
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

withOutputOption(
insight
  .command("get")
  .description("Get details of an insight (renders markdown description)")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
, ['markdown'])
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/insights/${encodeURIComponent(options.id)}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const insightDoc = await response.json();

      if (format === 'markdown') {
        console.log(insightDoc.description);
        return;
      }

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: '_id', label: 'ID' },
          { key: 'title', label: 'Title' },
          { key: 'category', label: 'Category', formatter: (r: any) => r.category || '' },
          { key: 'tags', label: 'Tags', formatter: (r: any) => (r.tags ?? []).join(', ') },
          { key: 'votes', label: 'Votes', formatter: (r: any) => String(r.upvotes - r.downvotes) },
          { key: 'referenceCount', label: 'References', formatter: (r: any) => String(r.referenceCount) },
          { key: 'blocked', label: 'Blocked', formatter: (r: any) => r.blocked ? 'Yes' : 'No' },
          { key: 'createdBy', label: 'Created By' },
          { key: 'description', label: 'Description' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([insightDoc], fields, format));
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
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

// ─── Task Prompt management ─────────────────────────────────────────────────

const taskPrompt = program
  .command("task-prompt")
  .description("Manage task prompts (content-addressed, immutable prompt entities)")
  .action(() => {
    taskPrompt.help();
  });

configureHelp(taskPrompt);

withOutputOption(
taskPrompt
  .command("list")
  .description("List all task prompts")
  .option("-s, --search <search>", "Filter by text content")
  .option("-l, --limit <n>", "Maximum number of results", "50")
  .option("--offset <n>", "Number of results to skip", "0")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const params = new URLSearchParams();
      if (options.search) params.set("search", options.search);
      if (options.limit) params.set("limit", options.limit);
      if (options.offset) params.set("offset", options.offset);
      const qs = params.toString();
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/task-prompts${qs ? `?${qs}` : ""}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const data = await response.json() as { items: Array<{ _id: string; text: string; features?: Array<{ featureId: string; detected: boolean; evaluated: boolean }>; createdAt: string }>; total: number };
      if (data.items.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No task prompts found."));
        return;
      }

      if (!isMachineReadable(format)) {
        console.log(label(`Found ${data.items.length} of ${data.total} task prompts:\n`));
      }

      const displayFields: DisplayField[] = [
        { key: '_id', label: 'ID',
          formatter: (tp: any) => tp._id.substring(0, 8) + '…',
          tableFormatter: (tp: any) => value(tp._id.substring(0, 8) + '…'),
        },
        { key: 'text', label: 'Text', formatter: (tp: any) => {
          const text = tp.text.replace(/\n/g, ' ');
          return text.length > 60 ? text.substring(0, 60) + '…' : text;
        }, tableFormatter: (tp: any) => {
          const text = tp.text.replace(/\n/g, ' ');
          const truncated = text.length > 60 ? text.substring(0, 60) + '…' : text;
          return dimTimestamp(truncated);
        }},
        { key: 'features', label: 'Features', formatter: (tp: any) => {
          if (!tp.features) return '—';
          const detected = tp.features.filter((f: any) => f.detected).length;
          return `${detected}/${tp.features.length}`;
        }},
        { key: 'createdAt', label: 'Created', formatter: (tp: any) => tp.createdAt ? new Date(tp.createdAt).toLocaleDateString() : '—' },
      ];

      console.log(formatData(data.items, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
taskPrompt
  .command("get")
  .description("Get details of a single task prompt")
  .requiredOption("-i, --id <id>", "Task prompt ID (UUID)")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/task-prompts/${encodeURIComponent(options.id)}`);

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const tp = await response.json() as {
        _id: string; text: string;
        features?: Array<{ featureId: string; detected: boolean; evaluated: boolean }>;
        featuresExtractedAt?: string;
        createdAt: string; deletedAt?: string;
      };

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: '_id', label: 'ID' },
          { key: 'text', label: 'Text' },
          { key: 'features', label: 'Features', formatter: (item: any) => {
            if (!item.features) return '(not extracted)';
            const detected = item.features.filter((f: any) => f.detected).length;
            return `${detected}/${item.features.length} detected`;
          }},
          { key: 'featuresExtractedAt', label: 'Extracted At' },
          { key: 'createdAt', label: 'Created' },
          { key: 'deletedAt', label: 'Deleted' },
        ];
        console.log(formatData([tp], fields, format));
        return;
      }

      console.log(`${label('ID:')}        ${value(tp._id)}`);
      console.log(`${label('Created:')}   ${value(tp.createdAt)}`);
      if (tp.deletedAt) console.log(`${label('Deleted:')}   ${value(tp.deletedAt)}`);
      console.log(`${label('Text:')}`);
      for (const line of tp.text.trim().split('\n')) {
        console.log(`  ${line}`);
      }

      if (tp.features && tp.features.length > 0) {
        const detected = tp.features.filter(f => f.detected);
        const notDetected = tp.features.filter(f => !f.detected && f.evaluated);
        const skipped = tp.features.filter(f => !f.evaluated);

        console.log(`\n${label('Features:')} ${value(String(detected.length))} detected, ${dimTimestamp(String(notDetected.length))} not detected, ${dimTimestamp(String(skipped.length))} skipped`);
        if (tp.featuresExtractedAt) console.log(`${label('Extracted:')} ${value(tp.featuresExtractedAt)}`);

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
      } else {
        console.log(`\n${label('Features:')} ${dimTimestamp('(not extracted)')}`);
      }

      console.log(`\n${label('View runs:')} ${dimTimestamp(`pnpm cli run list --task-prompt-id ${tp._id}`)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

taskPrompt
  .command("create")
  .description("Register a task prompt (idempotent — same text returns existing entity)")
  .option("-t, --text <text>", "Task prompt text")
  .option("-f, --file <path>", "Read task prompt text from file")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      let text = options.text;
      if (!text && options.file) {
        const absPath = resolve(options.file);
        if (!existsSync(absPath)) {
          console.error(errorText(`File not found: ${absPath}`));
          process.exit(1);
        }
        text = readFileSync(absPath, 'utf-8');
      }
      if (!text) {
        console.error(errorText("Error: provide --text or --file"));
        process.exit(1);
      }

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/task-prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      const tp = await response.json() as { _id: string; text: string; createdAt: string };
      console.log(successText(`Task prompt registered.`));
      console.log(`${label('ID:')}      ${value(tp._id)}`);
      console.log(`${label('Created:')} ${value(tp.createdAt)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

taskPrompt
  .command("delete")
  .description("Soft-delete a task prompt")
  .requiredOption("-i, --id <id>", "Task prompt ID (UUID)")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
  .action(async (options) => {
    try {
      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/task-prompts/${encodeURIComponent(options.id)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }

      console.log(successText(`Task prompt ${options.id} deleted.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
taskPrompt
  .command("extract-features")
  .description("Extract prompt features for a task prompt")
  .requiredOption("-i, --id <id>", "Task prompt ID (UUID)")
  .option("--model <model>", "LLM model to use for extraction")
  .option("--force", "Force re-extraction even if already extracted")
  .option("-u, --url <url>", "API base URL", process.env.SCOPE_API_URL || "http://localhost:3100")
)
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      if (!isMachineReadable(format)) {
        console.log(`${label('Extracting prompt features for task prompt')} ${value(options.id)}${label('...')}`);
      }

      const qs = options.force ? "?force=true" : "";
      const body: Record<string, unknown> = {};
      if (options.model) body.model = options.model;

      const response = await fetch(`${normalizeUrl(options.url)}/api/v1/task-prompts/${encodeURIComponent(options.id)}/extract-features${qs}`, {
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
        taskPromptId: string;
        features: Array<{ featureId: string; detected: boolean; evaluated: boolean }>;
        featuresExtractedAt: string;
        cached: boolean;
      };

      if (isMachineReadable(format)) {
        console.log(format === 'json' ? JSON.stringify(extraction, null, 2) : format === 'yaml' ? yamlStringify(extraction).trimEnd() : JSON.stringify(extraction));
        return;
      }

      const detected = extraction.features.filter(r => r.detected);
      const notDetected = extraction.features.filter(r => !r.detected && r.evaluated);
      const skipped = extraction.features.filter(r => !r.evaluated);

      if (extraction.cached) {
        console.log(dimTimestamp('(cached — use --force to re-extract)'));
      }

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
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Only parse when run directly (not when imported by tests)
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('/cli/src/index.ts') ||
  process.argv[1].endsWith('/cli/dist/index.js')
);
if (isDirectRun) {
  program.parse();
}

