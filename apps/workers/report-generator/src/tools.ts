// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineTool } from "@github/copilot-sdk";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";
import { execSync } from "child_process";

/**
 * Options for creating report tools.
 */
export interface CreateReportToolsOptions {
  /** Root directory of the extracted archive (contains run.yaml, iteration files, snapshots/) */
  archiveDir: string;
  /** Base URL of the scope-mt API (for insight CRUD only) */
  apiBaseUrl: string;
  /** Report ID for linking insights */
  reportId: string;
}

/**
 * Create file-based tools for the report agent.
 *
 * All run data is pre-extracted to disk before the Copilot SDK session starts.
 * The agent only needs file manipulation tools to explore the archive contents,
 * plus insight tools for creating/referencing insights via the API.
 */
export function createReportTools(options: CreateReportToolsOptions) {
  const { archiveDir, apiBaseUrl, reportId } = options;

  const readFile = defineTool("read_file", {
    description:
      "Read a file from the extracted run archive. The archive root contains:\n" +
      "- run.yaml: Full run metadata (scenario, persona, criteria, turns with results)\n" +
      "- iteration-N.har: HTTP archive for iteration N\n" +
      "- iteration-N.tool-calls.jsonl: Tool calls made during iteration N\n" +
      "- iteration-N.atif.trajectory.json: ATIF trajectory for iteration N\n" +
      "- iteration-N.chat-export.json: Raw chat export for iteration N\n" +
      "- iteration-N.chat-result.json: Agent result envelope for iteration N\n" +
      "- logs.jsonl: Run log events\n" +
      "- snapshots/iteration-N/: Extracted workspace snapshot for iteration N\n" +
      "Use a relative path from the archive root.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path relative to the archive root (e.g., 'run.yaml', 'iteration-1.tool-calls.jsonl', 'snapshots/iteration-1/src/index.ts').",
        },
      },
      required: ["path"],
    },
    handler: async (args: { path: string }) => {
      const resolvedPath = join(archiveDir, args.path);

      // Security: prevent path traversal
      const rel = relative(archiveDir, resolvedPath);
      if (rel.startsWith("..") || rel.startsWith("/")) {
        return { error: "Path must be within the archive directory" };
      }
      if (!existsSync(resolvedPath)) {
        return { error: `File not found: ${args.path}` };
      }
      try {
        const stat = statSync(resolvedPath);
        if (stat.isDirectory()) {
          return { error: `'${args.path}' is a directory, use list_directory instead` };
        }
        if (stat.size > 100_000) {
          const content = readFileSync(resolvedPath, "utf-8").substring(0, 100_000);
          return { content, truncated: true, totalSize: stat.size };
        }
        return { content: readFileSync(resolvedPath, "utf-8") };
      } catch (err) {
        return { error: `Failed to read file: ${err}` };
      }
    },
  });

  const listDirectory = defineTool("list_directory", {
    description:
      "List directory contents within the extracted run archive. Use relative paths from the archive root. " +
      "Use '.' or '' to list the archive root.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the archive root (e.g., '.', 'snapshots/iteration-1', 'snapshots/iteration-1/src').",
        },
      },
      required: ["path"],
    },
    handler: async (args: { path: string }) => {
      const resolvedPath = args.path === "." || args.path === ""
        ? archiveDir
        : join(archiveDir, args.path);

      // Security: prevent path traversal
      const rel = relative(archiveDir, resolvedPath);
      if (rel.startsWith("..")) {
        return { error: "Path must be within the archive directory" };
      }
      if (!existsSync(resolvedPath)) {
        return { error: `Directory not found: ${args.path}` };
      }
      try {
        const entries = readdirSync(resolvedPath, { withFileTypes: true });
        const items = entries
          .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
          .map((entry) => {
            const entryPath = join(resolvedPath, entry.name);
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
        return { path: args.path || ".", entries: items };
      } catch (err) {
        return { error: `Failed to list directory: ${err}` };
      }
    },
  });

  const searchFiles = defineTool("search_files", {
    description:
      "Search for text patterns in files within the extracted run archive using grep. " +
      "Use to find specific content across snapshots, logs, or tool call records.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Text pattern or regex to search for.",
        },
        path: {
          type: "string",
          description: "Relative path to search within (e.g., '.', 'snapshots/iteration-1', 'snapshots/iteration-1/src'). Defaults to archive root.",
        },
        filePattern: {
          type: "string",
          description: "Glob pattern to filter files (e.g., '*.ts', '*.jsonl'). Optional.",
        },
      },
      required: ["pattern"],
    },
    handler: async (args: { pattern: string; path?: string; filePattern?: string }) => {
      const searchPath = args.path && args.path !== "."
        ? join(archiveDir, args.path)
        : archiveDir;

      // Security: prevent path traversal
      const rel = relative(archiveDir, searchPath);
      if (rel.startsWith("..")) {
        return { error: "Path must be within the archive directory" };
      }
      try {
        const includeFlag = args.filePattern ? `--include='${args.filePattern}'` : "";
        const cmd = `grep -rn ${includeFlag} "${args.pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -50`;
        const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
        if (!output) {
          return { matches: [], message: "No matches found" };
        }
        // Make paths relative to archiveDir for readability
        const matches = output.split("\n").map((line) => {
          if (line.startsWith(archiveDir)) {
            return line.substring(archiveDir.length + 1);
          }
          return line;
        });
        return { matches };
      } catch {
        return { matches: [], message: "No matches found or search error" };
      }
    },
  });

  const searchInsights = defineTool("search_insights", {
    description:
      "Search existing insights by keyword query. Use this to check if a similar insight already exists before creating a new one. Returns matching insights sorted by reference count.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword search query to find similar insights.",
        },
      },
      required: ["query"],
    },
    handler: async (args: { query: string }) => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/api/v1/insights/search?q=${encodeURIComponent(args.query)}&blocked=false`
        );
        if (!response.ok) {
          return { error: `Failed to search insights: ${response.status} ${response.statusText}` };
        }
        const insights = await response.json();
        return {
          insights: insights.map((i: any) => ({
            id: i._id,
            title: i.title,
            description: i.description,
            category: i.category,
            referenceCount: i.referenceCount,
          })),
          total: insights.length,
        };
      } catch (err) {
        return { error: `Failed to search insights: ${err}` };
      }
    },
  });

  const createInsight = defineTool("create_insight", {
    description:
      "Create a brand-new insight. Only use this when search_insights confirms no similar insight exists. The description should be markdown-formatted.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short summary of the insight (one line).",
        },
        description: {
          type: "string",
          description: "Detailed markdown-formatted observation explaining the insight.",
        },
        category: {
          type: "string",
          description: "Category tag (e.g. 'agent-behavior', 'criteria-handling', 'tool-usage', 'scenario-design').",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Free-form tags for discoverability.",
        },
      },
      required: ["title", "description"],
    },
    handler: async (args: { title: string; description: string; category?: string; tags?: string[] }) => {
      try {
        const createResponse = await fetch(`${apiBaseUrl}/api/v1/insights`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: args.title,
            description: args.description,
            category: args.category,
            tags: args.tags,
            createdBy: "agent",
            sourceReportId: reportId,
          }),
        });
        if (!createResponse.ok) {
          return { error: `Failed to create insight: ${createResponse.status} ${createResponse.statusText}` };
        }
        const insight = await createResponse.json();

        const refResponse = await fetch(`${apiBaseUrl}/api/v1/reports/${reportId}/insights`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ insightId: insight._id, isNew: true }),
        });
        if (!refResponse.ok) {
          return { id: insight._id, title: insight.title, warning: "Created but failed to link to report" };
        }

        return { id: insight._id, title: insight.title, created: true, linkedToReport: true };
      } catch (err) {
        return { error: `Failed to create insight: ${err}` };
      }
    },
  });

  const referenceInsight = defineTool("reference_insight", {
    description:
      "Reference an existing insight from this report. Use this when search_insights found a matching insight.",
    parameters: {
      type: "object",
      properties: {
        insightId: {
          type: "string",
          description: "The ID of the existing insight to reference.",
        },
      },
      required: ["insightId"],
    },
    handler: async (args: { insightId: string }) => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/reports/${reportId}/insights`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ insightId: args.insightId, isNew: false }),
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          return { error: err.error || `Failed to reference insight: ${response.status}` };
        }
        return { insightId: args.insightId, referenced: true };
      } catch (err) {
        return { error: `Failed to reference insight: ${err}` };
      }
    },
  });

  return [
    readFile,
    listDirectory,
    searchFiles,
    searchInsights,
    createInsight,
    referenceInsight,
  ];
}
