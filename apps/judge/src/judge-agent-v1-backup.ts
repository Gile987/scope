// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CopilotClient, defineTool, SessionEvent } from "@github/copilot-sdk";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";
import { execSync } from "child_process";
import { ConversationTurn } from "shared";

export interface EvaluationInput {
  workspacePath: string;
  criteria: string[];
  conversationHistory: ConversationTurn[];
  personaInstructions?: string;
}

export interface EvaluationResult {
  passed: boolean;
  feedback: string;
}

/**
 * Creates filesystem inspection tools scoped to the given workspace path.
 */
function createFileTools(workspacePath: string) {
  const readFile = defineTool("read_file", {
    description:
      "Read the contents of a file in the workspace. Returns the full text content. Use relative paths from the workspace root.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file from the workspace root",
        },
      },
      required: ["path"],
    },
    handler: async (args: { path: string }) => {
      const fullPath = join(workspacePath, args.path);
      // Security: prevent path traversal
      if (!fullPath.startsWith(workspacePath)) {
        return { error: "Path traversal not allowed" };
      }
      if (!existsSync(fullPath)) {
        return { error: `File not found: ${args.path}` };
      }
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          return { error: `${args.path} is a directory, not a file. Use list_directory instead.` };
        }
        // Limit file size to prevent overwhelming the context
        if (stat.size > 100_000) {
          const content = readFileSync(fullPath, "utf-8").substring(0, 100_000);
          return { content, truncated: true, totalSize: stat.size };
        }
        const content = readFileSync(fullPath, "utf-8");
        return { content };
      } catch (err) {
        return { error: `Failed to read file: ${err}` };
      }
    },
  });

  const listDirectory = defineTool("list_directory", {
    description:
      "List the contents of a directory in the workspace. Returns file and directory names with their types and sizes.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Relative path to the directory from the workspace root. Use '.' for the root directory.",
        },
      },
      required: ["path"],
    },
    handler: async (args: { path: string }) => {
      const fullPath = join(workspacePath, args.path);
      if (!fullPath.startsWith(workspacePath)) {
        return { error: "Path traversal not allowed" };
      }
      if (!existsSync(fullPath)) {
        return { error: `Directory not found: ${args.path}` };
      }
      try {
        const entries = readdirSync(fullPath, { withFileTypes: true });
        const items = entries
          .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
          .map((entry) => {
            const entryPath = join(fullPath, entry.name);
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
      "Search for text patterns in files within the workspace using grep. Returns matching lines with file paths and line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Text pattern or regex to search for",
        },
        path: {
          type: "string",
          description:
            "Relative path to search in. Defaults to '.' (entire workspace).",
        },
        filePattern: {
          type: "string",
          description:
            "Glob pattern to filter files (e.g., '*.ts', '*.py'). Optional.",
        },
      },
      required: ["pattern"],
    },
    handler: async (args: {
      pattern: string;
      path?: string;
      filePattern?: string;
    }) => {
      const searchPath = join(workspacePath, args.path || ".");
      if (!searchPath.startsWith(workspacePath)) {
        return { error: "Path traversal not allowed" };
      }
      try {
        let cmd = `grep -rn --include='${args.filePattern || "*"}' "${args.pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -50`;
        const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
        if (!output) {
          return { matches: [], message: "No matches found" };
        }
        // Make paths relative to workspace
        const matches = output.split("\n").map((line) => {
          const relLine = line.replace(workspacePath + "/", "");
          return relLine;
        });
        return { matches };
      } catch {
        return { matches: [], message: "No matches found or search error" };
      }
    },
  });

  const fileExists = defineTool("file_exists", {
    description: "Check if a file or directory exists in the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to check",
        },
      },
      required: ["path"],
    },
    handler: async (args: { path: string }) => {
      const fullPath = join(workspacePath, args.path);
      if (!fullPath.startsWith(workspacePath)) {
        return { error: "Path traversal not allowed" };
      }
      const exists = existsSync(fullPath);
      let type: string | undefined;
      if (exists) {
        const stat = statSync(fullPath);
        type = stat.isDirectory() ? "directory" : "file";
      }
      return { path: args.path, exists, type };
    },
  });

  return [readFile, listDirectory, searchFiles, fileExists];
}

/**
 * Builds the system prompt for the judge agent.
 */
function buildSystemPrompt(
  criteria: string[],
  conversationHistory: ConversationTurn[],
  personaInstructions?: string
): string {
  const criteriaList = criteria
    .map((c, i) => `  ${i + 1}. ${c}`)
    .join("\n");

  const historySection =
    conversationHistory.length > 0
      ? `\n## Previous Iterations\n${conversationHistory
          .map(
            (t) =>
              `### Iteration ${t.iteration}\n- **Coding agent response**: ${(t.codingAgentResponse ?? "(no response captured)").substring(0, 500)}${(t.codingAgentResponse ?? "").length > 500 ? "..." : ""}\n- **Your previous feedback**: ${t.judgeFeedback.substring(0, 500)}${t.judgeFeedback.length > 500 ? "..." : ""}\n- **Passed**: ${t.passed}`
          )
          .join("\n\n")}`
      : "";

  const personaSection = personaInstructions
    ? `\n## Persona\n${personaInstructions}\n`
    : "";

  return `You are an expert code reviewer and judge evaluating whether generated code meets requirements.
${personaSection}
## Your Task
Inspect the workspace using the provided tools (read_file, list_directory, search_files, file_exists) and evaluate whether the code meets ALL of the following criteria:

## Criteria
${criteriaList}
${historySection}

## Instructions
1. Use the tools to thoroughly inspect the workspace — read key files, check directory structure, search for patterns.
2. Evaluate each criterion carefully.
3. Be constructive: if the code doesn't fully meet requirements, provide specific, actionable feedback about what needs to change.
4. Keep your feedback concise and focused on what the coding agent should do next.

## Output Format
Your response MUST start with one of these two signals:

If ALL criteria are met:
\`\`\`
REQUIREMENTS COMPLETE
[Brief summary of what was done correctly]
\`\`\`

If criteria are NOT fully met:
\`\`\`
REQUIREMENTS NOT MET
[Specific feedback on what needs to be fixed or improved, written as instructions for the coding agent]
\`\`\`

Do NOT include both signals. Choose exactly one.`;
}

/**
 * Runs the judge agent against a workspace snapshot using the Copilot SDK.
 */
export async function evaluateWorkspace(
  input: EvaluationInput
): Promise<EvaluationResult> {
  const { workspacePath, criteria, conversationHistory, personaInstructions } = input;

  const tools = createFileTools(workspacePath);
  const systemPrompt = buildSystemPrompt(criteria, conversationHistory, personaInstructions);

  const client = new CopilotClient();
  let fullResponse = "";

  try {
    const session = await client.createSession({
      model: process.env.JUDGE_MODEL || "gpt-4.1",
      streaming: true,
      tools,
      systemMessage: { mode: "replace", content: systemPrompt },
    });

    session.on((event: SessionEvent) => {
      if (event.type === "assistant.message_delta") {
        fullResponse += event.data.deltaContent;
      }
    });

    const timeout = parseInt(process.env.JUDGE_TIMEOUT || "300000");
    await session.sendAndWait({
      prompt:
        "Evaluate the workspace against the criteria. Use the file tools to inspect the code, then provide your verdict.",
    }, timeout);

    await client.stop();
  } catch (error) {
    console.error("[judge-agent] Copilot SDK error:", error);
    throw new Error(
      `Judge agent evaluation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Parse the response
  return parseJudgeResponse(fullResponse);
}

/**
 * Parses the judge agent response to extract passed/feedback.
 */
function parseJudgeResponse(response: string): EvaluationResult {
  const trimmed = response.trim();

  if (trimmed.includes("REQUIREMENTS COMPLETE")) {
    // Extract feedback after the signal
    const feedback = trimmed
      .replace(/^.*REQUIREMENTS COMPLETE\s*/s, "")
      .trim();
    return {
      passed: true,
      feedback: feedback || "All requirements met.",
    };
  }

  if (trimmed.includes("REQUIREMENTS NOT MET")) {
    const feedback = trimmed
      .replace(/^.*REQUIREMENTS NOT MET\s*/s, "")
      .trim();
    return {
      passed: false,
      feedback:
        feedback ||
        "Requirements not met. Please review the criteria and try again.",
    };
  }

  // Fallback: if neither signal found, assume not passed and use full response as feedback
  console.warn(
    "[judge-agent] Response did not contain expected signal, treating as not passed"
  );
  return {
    passed: false,
    feedback: trimmed || "Judge did not provide a clear evaluation.",
  };
}
