#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import EventSource from "eventsource";
import React from "react";
import { render } from "ink";
import { DemoApp } from "./components/DemoApp.js";
import { resolveScenarioAndPersona } from "./config-loader.js";

const program = new Command();

const DEFAULT_WORKERS = [
  "coder-acp-claude-code",
  "coder-acp-copilot",
  "coder-vscode-web",
];

program
  .name("worker-cli")
  .description("CLI for submitting requests to the worker API")
  .version("1.0.0")
  .action(() => {
    program.help();
  });

program
  .command("submit")
  .description("Submit a request to a worker and stream logs")
  .option("-s, --scenario <path>", "Path to scenario YAML file (provides task + criteria)")
  .option("-p, --persona <path>", "Path to persona YAML file (provides judge personality)")
  .option("-t, --traits <path>", "Path to traits.yaml (default: config/traits.yaml next to persona)")
  .option("-m, --message <message>", "Message/task to process (overrides scenario task)")
  .option("-w, --worker <worker>", "Worker to use (coder-acp-claude-code, coder-acp-copilot, coder-vscode-web)", "coder-acp-copilot")
  .option("-c, --criteria <criteria...>", "Evaluation criteria (overrides scenario criteria)")
  .option("--max-iterations <number>", "Max judge iterations for multi-turn mode", parseInt)
  .option("-u, --url <url>", "API base URL", process.env.API_URL || "http://localhost:3000")
  .option("--no-stream", "Don't stream logs, just submit")
  .action(async (options) => {
    const { scenario, persona, traits, worker, url, stream, maxIterations } = options;

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

        console.log(`Scenario: ${scenario}`);
        if (persona) console.log(`Persona: ${persona}`);
        console.log(`Task: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`);
        console.log(`Criteria: ${criteria.length} items`);
        console.log();
      }

      if (!message) {
        console.error("Error: --message or --scenario is required");
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
        console.error("Error:", error);
        process.exit(1);
      }

      const result = await response.json();
      console.log(`Request submitted: ${result.id}`);
      console.log(`Worker: ${result.workerType}`);
      console.log(`Mode: ${result.mode || 'one-shot'}`);
      console.log(`Status: ${result.status}`);

      if (!stream) {
        return;
      }

      // Stream logs
      console.log("\n--- Streaming logs ---\n");

      const eventSource = new EventSource(`${url}/api/v1/requests/${result.id}/logs`);

      eventSource.onmessage = (event) => {
        try {
          const log = JSON.parse(event.data);
          const timestamp = new Date(log.timestamp).toLocaleTimeString();
          const level = log.level.toUpperCase().padEnd(5);
          console.log(`[${timestamp}] [${level}] ${log.message}`);
          if (log.data && Object.keys(log.data).length > 0) {
            const dataStr = JSON.stringify(log.data, null, 2)
              .split("\n")
              .map((line) => `           ${line}`)
              .join("\n");
            console.log(dataStr);
          }
        } catch {
          console.log(event.data);
        }
      };

      eventSource.addEventListener("done", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data);
          console.log(`\n--- Processing ${data.status} ---`);
        } catch {
          console.log("\n--- Done ---");
        }
        eventSource.close();
        process.exit(0);
      });

      eventSource.addEventListener("error", () => {
        console.error("\n--- Connection error ---");
        eventSource.close();
        process.exit(1);
      });

      eventSource.addEventListener("timeout", () => {
        console.log("\n--- Stream timeout ---");
        eventSource.close();
        process.exit(0);
      });

    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Get status of a request")
  .argument("<id>", "Request ID")
  .option("-u, --url <url>", "API base URL", process.env.API_URL || "http://localhost:3000")
  .action(async (id, options) => {
    try {
      const response = await fetch(`${options.url}/api/v1/requests/${id}`);

      if (!response.ok) {
        const error = await response.json();
        console.error("Error:", error);
        process.exit(1);
      }

      const request = await response.json();
      console.log(JSON.stringify(request, null, 2));
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("logs")
  .description("Stream logs for a request")
  .argument("<id>", "Request ID")
  .option("-u, --url <url>", "API base URL", process.env.API_URL || "http://localhost:3000")
  .option("--from-start", "Include historical logs from start")
  .action(async (id, options) => {
    const url = options.fromStart
      ? `${options.url}/api/v1/requests/${id}/logs?fromStart=true`
      : `${options.url}/api/v1/requests/${id}/logs`;

    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const log = JSON.parse(event.data);
        const timestamp = new Date(log.timestamp).toLocaleTimeString();
        const level = log.level.toUpperCase().padEnd(5);
        console.log(`[${timestamp}] [${level}] ${log.message}`);
      } catch {
        console.log(event.data);
      }
    };

    eventSource.addEventListener("done", () => {
      console.log("\n--- Done ---");
      eventSource.close();
      process.exit(0);
    });

    eventSource.addEventListener("error", () => {
      console.error("\n--- Connection error ---");
      eventSource.close();
      process.exit(1);
    });
  });

program
  .command("list")
  .description("List all requests")
  .option("-u, --url <url>", "API base URL", process.env.API_URL || "http://localhost:3000")
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
        console.error("Error:", error);
        process.exit(1);
      }

      const requests = await response.json();
      console.log(JSON.stringify(requests, null, 2));
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("demo")
  .description("Run concurrent requests to all coders with a live TUI dashboard")
  .requiredOption("-m, --message <message>", "Message/prompt to send to all coders")
  .option("-c, --count <count>", "Number of requests to send to each coder", "1")
  .option("-u, --url <url>", "API base URL", process.env.API_URL || "http://localhost:3000")
  .option("-w, --workers <workers>", "Comma-separated list of workers", DEFAULT_WORKERS.join(","))
  .action((options) => {
    const { message, count, url, workers: workersStr } = options;
    const workersList = workersStr.split(",").map((w: string) => w.trim());
    const countNum = parseInt(count, 10);

    if (isNaN(countNum) || countNum < 1) {
      console.error("Error: count must be a positive integer");
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

program.parse();
