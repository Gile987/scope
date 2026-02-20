// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineTool } from "@github/copilot-sdk";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

/**
 * Create tools for the report agent to access run data via the REST API
 * and inspect workspace snapshots extracted to a local temp directory.
 */
export function createReportTools(
  apiBaseUrl: string,
  requestId: string,
  snapshotsDir: string
) {
  const getRunSummary = defineTool("get_run_summary", {
    description:
      "Get the summary of the benchmark run including scenario, worker type, persona, status, iteration count, and criteria list.",
    parameters: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/requests/${requestId}`);
        if (!response.ok) {
          return { error: `Failed to fetch run: ${response.status} ${response.statusText}` };
        }
        const run = await response.json();
        return {
          id: run._id,
          task: run.scenario?.task,
          criteria: run.scenario?.criteria,
          scenarioVersion: run.scenario?.version,
          workerType: run.workerType,
          status: run.status,
          persona: run.persona,
          personaInstructions: run.personaInstructions,
          maxIterations: run.maxIterations,
          turnCount: run.turns?.length || 0,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          error: run.error,
        };
      } catch (err) {
        return { error: `Failed to fetch run summary: ${err}` };
      }
    },
  });

  const listTurns = defineTool("list_turns", {
    description:
      "List all turns in the run with their iteration number, pass/fail status, and criteria results summary.",
    parameters: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/requests/${requestId}`);
        if (!response.ok) {
          return { error: `Failed to fetch run: ${response.status} ${response.statusText}` };
        }
        const run = await response.json();
        const turns = (run.turns || []).map((turn: any) => ({
          iteration: turn.iteration,
          passed: turn.passed,
          timestamp: turn.timestamp,
          criteriaResults: (turn.criteriaResults || []).map((cr: any) => ({
            criterionId: cr.criterionId,
            passed: cr.passed,
            evaluated: cr.evaluated,
          })),
          hasSnapshot: !!turn.snapshotUrl,
        }));
        return { turns, total: turns.length };
      } catch (err) {
        return { error: `Failed to list turns: ${err}` };
      }
    },
  });

  const getTurnDetail = defineTool("get_turn_detail", {
    description:
      "Get full details for a specific turn including the coding agent's response, judge feedback, and per-criterion results with feedback.",
    parameters: {
      type: "object",
      properties: {
        iteration: {
          type: "number",
          description: "The iteration number (1-based) of the turn to inspect.",
        },
      },
      required: ["iteration"],
    },
    handler: async (args: { iteration: number }) => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/requests/${requestId}`);
        if (!response.ok) {
          return { error: `Failed to fetch run: ${response.status} ${response.statusText}` };
        }
        const run = await response.json();
        const turn = (run.turns || []).find((t: any) => t.iteration === args.iteration);
        if (!turn) {
          return { error: `Turn ${args.iteration} not found` };
        }
        return {
          iteration: turn.iteration,
          passed: turn.passed,
          timestamp: turn.timestamp,
          codingAgentResponse: turn.codingAgentResponse,
          judgeFeedback: turn.judgeFeedback,
          criteriaResults: turn.criteriaResults || [],
          hasSnapshot: !!turn.snapshotUrl,
        };
      } catch (err) {
        return { error: `Failed to get turn detail: ${err}` };
      }
    },
  });

  const getCriteriaTrajectory = defineTool("get_criteria_trajectory", {
    description:
      "Get the pass/fail trajectory for each criterion across all turns. Useful for spotting regressions and flip-flops.",
    parameters: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/requests/${requestId}`);
        if (!response.ok) {
          return { error: `Failed to fetch run: ${response.status} ${response.statusText}` };
        }
        const run = await response.json();
        const turns = run.turns || [];

        // Collect all criterion IDs
        const criterionIds = new Set<string>();
        for (const turn of turns) {
          for (const cr of turn.criteriaResults || []) {
            criterionIds.add(cr.criterionId);
          }
        }

        // Build trajectory per criterion
        const trajectory: Record<string, { iteration: number; passed: boolean; evaluated: boolean }[]> = {};
        for (const id of criterionIds) {
          trajectory[id] = turns.map((turn: any) => {
            const cr = (turn.criteriaResults || []).find((c: any) => c.criterionId === id);
            return {
              iteration: turn.iteration,
              passed: cr?.passed ?? false,
              evaluated: cr?.evaluated ?? false,
            };
          });
        }

        return { trajectory, criterionIds: [...criterionIds] };
      } catch (err) {
        return { error: `Failed to compute criteria trajectory: ${err}` };
      }
    },
  });

  const extractSnapshot = defineTool("extract_snapshot", {
    description:
      "Download and extract a workspace snapshot for a specific iteration to a local directory. " +
      "After extraction, use read_file, list_directory, and search_files to inspect the workspace contents. " +
      "Returns the path to the extracted directory.",
    parameters: {
      type: "object",
      properties: {
        iteration: {
          type: "number",
          description: "The iteration number (1-based) to download the snapshot for.",
        },
      },
      required: ["iteration"],
    },
    handler: async (args: { iteration: number }) => {
      const iterDir = join(snapshotsDir, `iteration-${args.iteration}`);
      
      // Check if already extracted
      if (existsSync(iterDir)) {
        return { path: iterDir, cached: true };
      }

      try {
        const response = await fetch(
          `${apiBaseUrl}/api/v1/requests/${requestId}/snapshots/${args.iteration}`
        );
        if (!response.ok) {
          return { error: `Failed to download snapshot: ${response.status} ${response.statusText}` };
        }

        const { mkdirSync } = await import("fs");
        mkdirSync(iterDir, { recursive: true });

        // Write tar.gz to temp file and extract
        const buffer = Buffer.from(await response.arrayBuffer());
        const tarPath = join(snapshotsDir, `iteration-${args.iteration}.tar.gz`);
        const { writeFileSync } = await import("fs");
        writeFileSync(tarPath, buffer);

        execSync(`tar -xzf "${tarPath}" -C "${iterDir}"`, { timeout: 30000 });

        // Clean up tar file
        const { unlinkSync } = await import("fs");
        unlinkSync(tarPath);

        return { path: iterDir, cached: false };
      } catch (err) {
        return { error: `Failed to extract snapshot: ${err}` };
      }
    },
  });

  const readFile = defineTool("read_file", {
    description:
      "Read a file from an extracted snapshot directory. Use after extract_snapshot to inspect workspace contents.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the file (within an extracted snapshot directory).",
        },
      },
      required: ["path"],
    },
    handler: async (args: { path: string }) => {
      if (!args.path.startsWith(snapshotsDir)) {
        return { error: "Path must be within the snapshots directory" };
      }
      if (!existsSync(args.path)) {
        return { error: `File not found: ${args.path}` };
      }
      try {
        const stat = statSync(args.path);
        if (stat.isDirectory()) {
          return { error: `${args.path} is a directory, use list_directory instead` };
        }
        if (stat.size > 100_000) {
          const content = readFileSync(args.path, "utf-8").substring(0, 100_000);
          return { content, truncated: true, totalSize: stat.size };
        }
        return { content: readFileSync(args.path, "utf-8") };
      } catch (err) {
        return { error: `Failed to read file: ${err}` };
      }
    },
  });

  const listDirectory = defineTool("list_directory", {
    description:
      "List directory contents within an extracted snapshot. Use after extract_snapshot.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the directory (within an extracted snapshot directory).",
        },
      },
      required: ["path"],
    },
    handler: async (args: { path: string }) => {
      if (!args.path.startsWith(snapshotsDir)) {
        return { error: "Path must be within the snapshots directory" };
      }
      if (!existsSync(args.path)) {
        return { error: `Directory not found: ${args.path}` };
      }
      try {
        const entries = readdirSync(args.path, { withFileTypes: true });
        const items = entries
          .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
          .map((entry) => {
            const entryPath = join(args.path, entry.name);
            try {
              const stat = statSync(entryPath);
              return {
                name: entry.name,
                type: entry.isDirectory() ? "directory" : "file",
                size: entry.isFile() ? stat.size : undefined,
              };
            } catch {
              return { name: entry.name, type: "unknown" };
            }
          });
        return { path: args.path, entries: items };
      } catch (err) {
        return { error: `Failed to list directory: ${err}` };
      }
    },
  });

  const searchFiles = defineTool("search_files", {
    description:
      "Search for text patterns in files within an extracted snapshot using grep.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Text pattern or regex to search for.",
        },
        path: {
          type: "string",
          description: "Absolute path to search in (within an extracted snapshot directory).",
        },
        filePattern: {
          type: "string",
          description: "Glob pattern to filter files (e.g., '*.ts'). Optional.",
        },
      },
      required: ["pattern", "path"],
    },
    handler: async (args: { pattern: string; path: string; filePattern?: string }) => {
      if (!args.path.startsWith(snapshotsDir)) {
        return { error: "Path must be within the snapshots directory" };
      }
      try {
        const cmd = `grep -rn --include='${args.filePattern || "*"}' "${args.pattern.replace(/"/g, '\\"')}" "${args.path}" 2>/dev/null | head -50`;
        const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
        if (!output) {
          return { matches: [], message: "No matches found" };
        }
        return { matches: output.split("\n") };
      } catch {
        return { matches: [], message: "No matches found or search error" };
      }
    },
  });

  return [
    getRunSummary,
    listTurns,
    getTurnDetail,
    getCriteriaTrajectory,
    extractSnapshot,
    readFile,
    listDirectory,
    searchFiles,
  ];
}
