// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CopilotClient, defineTool, SessionEvent } from "@github/copilot-sdk";
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, resolve, sep } from "path";
import { execFileSync } from "child_process";
import {
  CriteriaConfig,
  CriterionResult,
  DetailedEvaluationResult,
  ConversationTurn,
  DependencyGraph,
  GateId,
  TokenManagerClient,
  withRetry,
} from "shared";
import {
  type AgentTrajectory,
  createTrajectoryTools,
} from "./agent-trajectory.js";

export interface JudgeStrategyContext {
  workspacePath: string;
  criteria: CriteriaConfig[];
  criteriaGraph: DependencyGraph;
  conversationHistory: ConversationTurn[];
  personaInstructions?: string;
  model?: string;
  /** Called when an individual criterion result is available (for real-time progress) */
  onProgress?: (result: CriterionResult) => void;
  /** Which gate is being evaluated. Defaults to select. */
  gate?: GateId;
  /** The coding agent's captured trajectory (normalized from the HAR tool calls
   * for gates, or the ATIF for observations). */
  trajectory?: AgentTrajectory;
}

/**
 * Base class for judge evaluation strategies
 */
/** Default timeout for sendAndWait calls (8 minutes) */
const DEFAULT_JUDGE_TIMEOUT = 480_000;

/** Default number of retries for sendAndWait calls */
const DEFAULT_JUDGE_RETRIES = 3;

/**
 * The `## Your Tools` + `## How to Judge` guidance injected into the judge
 * system prompt when the coding agent's tool calls/outputs were captured for
 * this iteration.
 *
 * The judge runs headless and cannot run any commands itself — it can only
 * inspect the workspace and read what the coding agent already did. This text
 * keeps the judge's own read-only tools unambiguous from the coding agent's
 * tools/commands, and frames the codebase and captured tool outputs as two
 * complementary, equally authoritative sources of evidence so the judge bases
 * its decision on actual evidence instead of demanding the agent re-prove work
 * it has already done. It is intentionally generic across all criteria.
 */
export const TRAJECTORY_GUIDANCE = `## Your Tools
You have read-only tools to gather evidence — you cannot run any commands or coding-agent tools yourself, you can only read what the agent already did:
- Inspect the resulting codebase: read_file, list_directory, search_files, file_exists.
- See what tools the agent HAD available (its catalog): list_agent_tools, then get_agent_tools(toolNames) for a tool's full description and parameter schema.
- See what the agent DID: list_agent_tool_calls to triage its invocations (id, name, a short summary and a preview of each output), then get_agent_tool_calls(toolCallIds) for the full arguments and captured output of the calls you care about.
- get_trajectory_overview gives a high-level orientation (agent, model, steps) without the raw system prompt.
When get_agent_tool_calls or get_agent_tools returns a responseFile or descriptionFile (large outputs are spilled to a file instead of inlined), open that path with read_file.

## How to Judge
The resulting codebase and the agent's captured trajectory are two complementary, equally authoritative sources of evidence — examine both. The files show the resulting state of the code; the captured tool calls and their outputs show what actually happened while the agent worked, including intermediate actions the final files no longer reveal (for example a dependency added and then later removed within the run). Start with list_agent_tool_calls to see what the agent did, then drill into the relevant calls with get_agent_tool_calls. When a criterion concerns something the agent did or ran, take the agent's captured output and exit status as the record of what happened, rather than asking the agent to redo or re-prove work the evidence already shows. If a criterion's wording tells you to run, execute, or re-run a command, ignore that instruction and judge the outcome from the captured trajectory together with the codebase.`;

/**
 * Tool filter applied to every judge session.
 *
 * The Copilot SDK's `CopilotClient` defaults to `mode: "copilot-cli"`, which
 * injects the full set of built-in CLI tools (bash, edit, view, ...) into the
 * session alongside the read-only `custom:*` tools we register in
 * `createFileTools`/`createTrajectoryTools`. Those built-ins are NOT
 * `skipPermission`, and the judge runs headless (no TUI to answer prompts).
 *
 * The failure mode this guards against: instead of reading the coder's captured
 * output via `list_agent_tool_calls`/`get_agent_tool_calls`, the judge model decides to
 * "verify" a build/test by running the command itself through the built-in
 * `bash` tool. Headless, that call is denied with "could not request permission
 * from user". The judge then mis-reports this as the coder's result ("execution
 * is blocked by a permission error"), producing a bogus, non-deterministic
 * failure even when the coder's command actually succeeded. See scope #1117.
 *
 * Restricting `availableTools` to `custom:*` (and explicitly excluding
 * `builtin:*`/`mcp:*` as defense in depth, since `excludedTools` always wins)
 * guarantees the model can only ever call our injected, skipPermission tools.
 */
export const JUDGE_AVAILABLE_TOOLS = ["custom:*"] as const;
export const JUDGE_EXCLUDED_TOOLS = ["builtin:*", "mcp:*"] as const;

/**
 * Returns true only if `target` resolves to a path inside (or equal to) the
 * workspace `root`. A plain `startsWith` check is unsafe: `join()` normalizes
 * `..`, so `join("/tmp/ws", "../ws2/x")` → `/tmp/ws2/x`, which shares the
 * `/tmp/ws` prefix and would slip past `startsWith("/tmp/ws")`. We compare the
 * fully-resolved paths and require an exact match or a separator boundary so a
 * sibling like `/tmp/ws2` can never be mistaken for being under `/tmp/ws`.
 * Both tools' handlers rely on this since they are `skipPermission: true` and
 * therefore callable non-interactively by the model.
 */
export function isWithinWorkspace(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(resolvedRoot + sep)
  );
}

/**
 * Returns true if `target` resolves inside (or equal to) ANY of `roots`. Used so
 * read_file/file_exists may read both the workspace and a judge-created spill dir
 * (created OUTSIDE the workspace for oversized trajectory tool outputs) without
 * weakening the per-root traversal guard — each root is still checked with the
 * exact-or-separator-boundary rule of `isWithinWorkspace`.
 */
export function isWithinAnyRoot(roots: string[], target: string): boolean {
  return roots.some((root) => isWithinWorkspace(root, target));
}

export abstract class JudgeStrategy {
  protected model: string;
  protected timeout: number;
  protected maxRetries: number;
  protected tokenClient: TokenManagerClient;

  constructor(model?: string) {
    this.model = model || process.env.JUDGE_MODEL || "gpt-5.4-mini";
    this.timeout = parseInt(process.env.JUDGE_TIMEOUT || String(DEFAULT_JUDGE_TIMEOUT));
    this.maxRetries = parseInt(process.env.JUDGE_RETRIES || String(DEFAULT_JUDGE_RETRIES));
    this.tokenClient = new TokenManagerClient();
    console.log(
      `[judge-strategy] Initialized: model=${this.model}, timeout=${this.timeout}ms, retries=${this.maxRetries}`
    );
  }

  abstract evaluate(
    context: JudgeStrategyContext
  ): Promise<DetailedEvaluationResult>;

  /**
   * Create filesystem inspection tools scoped to the workspace
   */
  protected createFileTools(
    workspacePath: string,
    opts?: { extraReadRoots?: string[] },
  ) {
    const workspaceRoot = resolve(workspacePath);
    // Additional roots (OUTSIDE the workspace) that read_file/file_exists may
    // read by ABSOLUTE path — used for the trajectory spill dir so the judge can
    // open oversized tool outputs returned as responseFile/descriptionFile.
    // list_directory/search_files stay workspace-only so the codebase view the
    // judge inspects is never polluted by spill files.
    const extraReadRoots = (opts?.extraReadRoots ?? []).map((r) => resolve(r));
    const readRoots = [workspaceRoot, ...extraReadRoots];
    const readFile = defineTool("read_file", {
      description:
        "Read the contents of a file. Returns the full text content. Use a relative path from the workspace root, or an absolute path returned as responseFile/descriptionFile by the agent-trajectory tools.",
      // Read-only, workspace-scoped, traversal-guarded tools must run without a
      // permission prompt: the judge is headless (no TUI), so the v3 runtime
      // would otherwise deny every call with "could not request permission from
      // user", silently breaking all workspace inspection. See scope-doc#64.
      skipPermission: true,
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
        const fullPath = isAbsolute(args.path)
          ? resolve(args.path)
          : join(workspaceRoot, args.path);
        if (!isWithinAnyRoot(readRoots, fullPath)) {
          return { error: "Path traversal not allowed" };
        }
        if (!existsSync(fullPath)) {
          return { error: `File not found: ${args.path}` };
        }
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            return {
              error: `${args.path} is a directory, not a file. Use list_directory instead.`,
            };
          }
          if (stat.size > 100_000) {
            const content = readFileSync(fullPath, "utf-8").substring(
              0,
              100_000
            );
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
      skipPermission: true,
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
        const fullPath = join(workspaceRoot, args.path);
        if (!isWithinWorkspace(workspaceRoot, fullPath)) {
          return { error: "Path traversal not allowed" };
        }
        if (!existsSync(fullPath)) {
          return { error: `Directory not found: ${args.path}` };
        }
        try {
          const entries = readdirSync(fullPath, { withFileTypes: true });
          const items = entries
            .filter(
              (e) => !e.name.startsWith(".") && e.name !== "node_modules"
            )
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
      skipPermission: true,
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
        const searchPath = join(workspaceRoot, args.path || ".");
        if (!isWithinWorkspace(workspaceRoot, searchPath)) {
          return { error: "Path traversal not allowed" };
        }
        try {
          // Run grep without a shell. Passing an argv array (and `-e` before the
          // pattern) means user-controlled values are never interpreted by a
          // shell, eliminating the command-injection surface (e.g. `$(...)`,
          // backticks). This matters because the tool is skipPermission: true.
          let output: string;
          try {
            output = execFileSync(
              "grep",
              [
                "-rn",
                `--include=${args.filePattern || "*"}`,
                "-e",
                args.pattern,
                searchPath,
              ],
              {
                encoding: "utf-8",
                timeout: 10000,
                stdio: ["ignore", "pipe", "ignore"],
                maxBuffer: 10 * 1024 * 1024,
              }
            );
          } catch (err) {
            // grep exits 1 when there are no matches — that's not an error.
            const status = (err as { status?: number }).status;
            if (status === 1) {
              return { matches: [], message: "No matches found" };
            }
            throw err;
          }
          const trimmed = output.trim();
          if (!trimmed) {
            return { matches: [], message: "No matches found" };
          }
          const matches = trimmed
            .split("\n")
            .slice(0, 50)
            .map((line) => line.replace(workspaceRoot + sep, ""));
          return { matches };
        } catch {
          return { matches: [], message: "No matches found or search error" };
        }
      },
    });

    const fileExists = defineTool("file_exists", {
      description: "Check if a file or directory exists in the workspace.",
      skipPermission: true,
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
        const fullPath = isAbsolute(args.path)
          ? resolve(args.path)
          : join(workspaceRoot, args.path);
        if (!isWithinAnyRoot(readRoots, fullPath)) {
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
   * Run a Copilot session with given prompt and tools, retrying on timeout.
   *
   * When a trajectory with at least one captured call is supplied, the unified
   * trajectory navigation tools are registered (mirroring the previous
   * `toolCalls.length > 0` gate) and a per-evaluation spill dir is created
   * OUTSIDE the workspace for oversized tool outputs; read_file is granted that
   * dir as an extra read root so the judge can open spilled files. The spill dir
   * is best-effort removed when the session finishes.
   */
  protected async runCopilotSession(
    workspacePath: string,
    systemPrompt: string,
    userPrompt: string,
    trajectory?: AgentTrajectory
  ): Promise<string> {
    const hasTrajectory = !!trajectory && trajectory.calls.length > 0;
    const spillDir = hasTrajectory
      ? mkdtempSync(join(tmpdir(), "judge-trajectory-"))
      : undefined;
    const tools = [
      ...this.createFileTools(
        workspacePath,
        spillDir ? { extraReadRoots: [spillDir] } : undefined,
      ),
      ...(hasTrajectory ? createTrajectoryTools(trajectory!, spillDir!) : []),
    ];

    try {
      return await withRetry(
        () => this.doRunCopilotSession(tools, systemPrompt, userPrompt),
        {
          maxRetries: this.maxRetries,
          baseDelayMs: 10_000,
          maxDelayMs: 30_000,
          isRetryable: (error) => {
            const msg = error instanceof Error ? error.message : String(error);
            return (
              msg.includes("timeout") ||
              msg.includes("Timeout") ||
              msg.includes("aborted") ||
              msg.includes("ECONNRESET") ||
              msg.includes("socket hang up")
            );
          },
          onRetry: (error, attempt) => {
            const msg = error instanceof Error ? error.message : String(error);
            console.warn(
              `[judge-strategy] sendAndWait attempt ${attempt} failed (retrying in ≤30s): ${msg.substring(0, 200)}`
            );
          },
        }
      );
    } finally {
      if (spillDir) {
        try {
          rmSync(spillDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup of the out-of-workspace spill dir
        }
      }
    }
  }

  /**
   * Builds the `createSession` config for a judge session. Extracted so the
   * tool-restriction policy (availableTools/excludedTools) is unit-testable
   * without spinning up a real Copilot runtime. See {@link JUDGE_AVAILABLE_TOOLS}.
   */
  protected buildSessionConfig(tools: any[], systemPrompt: string) {
    return {
      model: this.model,
      streaming: true as const,
      tools,
      availableTools: [...JUDGE_AVAILABLE_TOOLS],
      excludedTools: [...JUDGE_EXCLUDED_TOOLS],
      systemMessage: { mode: "replace" as const, content: systemPrompt },
    };
  }

  private async doRunCopilotSession(
    tools: any[],
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    const githubToken = await this.tokenClient.acquireToken("copilot-sdk");
    const client = new CopilotClient({ gitHubToken: githubToken });
    let fullResponse = "";

    try {
      const session = await client.createSession(
        this.buildSessionConfig(tools, systemPrompt) as any
      );

      session.on((event: SessionEvent) => {
        if (event.type === "assistant.message_delta") {
          fullResponse += event.data.deltaContent;
        }
      });

      await session.sendAndWait({ prompt: userPrompt }, this.timeout);
      await client.stop();

      return fullResponse;
    } catch (error) {
      // Ensure client is stopped even on failure
      try { await client.stop(); } catch { /* ignore cleanup errors */ }
      console.error("[judge-strategy] Copilot SDK error:", error);
      throw new Error(
        `Judge evaluation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * BundledStrategy: Evaluate all criteria in a single session
 *
 * Expects JSON response with per-criterion results:
 * {"results": [{"criterion": "id", "passed": true|false, "feedback": "..."}]}
 */
export class BundledStrategy extends JudgeStrategy {
  async evaluate(
    context: JudgeStrategyContext
  ): Promise<DetailedEvaluationResult> {
    const {
      workspacePath,
      criteria,
      conversationHistory,
      personaInstructions,
      trajectory,
    } = context;

    const systemPrompt = this.buildSystemPrompt(
      personaInstructions,
      !!trajectory && trajectory.calls.length > 0
    );

    const userPrompt = this.buildUserPrompt(criteria, conversationHistory);

    const response = await this.runCopilotSession(
      workspacePath,
      systemPrompt,
      userPrompt,
      trajectory
    );

    return this.parseJsonResponse(response, criteria, context.onProgress);
  }

  /**
   * Builds the invariant system prompt (role, persona, tools, judging method,
   * instructions, output format). It does NOT contain the criteria or the
   * previous-iteration history — those are per-request data carried by the user
   * prompt (see {@link buildUserPrompt}) so the system prompt stays identical
   * across every criterion and iteration in a run.
   */
  private buildSystemPrompt(
    personaInstructions?: string,
    hasTrajectory?: boolean
  ): string {
    const personaSection = personaInstructions
      ? `\n## Persona\n${personaInstructions}\n`
      : "";

    const toolOutputsSection = hasTrajectory
      ? `\n${TRAJECTORY_GUIDANCE}\n`
      : "";

    return `You are an expert code reviewer evaluating the tool calls, logs and generated code produced by a coding agent.
${personaSection}
## What to Evaluate
Evaluate whether the coding agent's work — its generated code together with the captured outputs of the tools it ran — meets each criterion provided in the user message.
${toolOutputsSection}
## Instructions
1. Gather evidence from both the workspace and the coding agent's captured tool outputs.
2. Evaluate EACH criterion individually.
3. For each criterion, provide specific feedback about what you found.
4. Be constructive and actionable in your feedback.

## Output Format
Your response MUST be valid JSON with this structure:
\`\`\`json
{
  "results": [
    {"criterion": "criterion-id", "passed": true, "feedback": "Brief explanation of what was found"},
    {"criterion": "criterion-id", "passed": false, "feedback": "Specific explanation of what's missing"}
  ]
}
\`\`\`

IMPORTANT: Return ONLY the JSON, no additional text before or after.`;
  }

  /**
   * Builds the per-request user prompt: the criteria to evaluate plus any
   * previous-iteration context. This is the data the (invariant) system prompt
   * refers to.
   */
  private buildUserPrompt(
    criteria: CriteriaConfig[],
    conversationHistory: ConversationTurn[]
  ): string {
    const criteriaList = criteria
      .map((c) => `  - ${c.id}: ${c.prompt}`)
      .join("\n");

    const historySection =
      conversationHistory.length > 0
        ? `\n\n## Previous Iterations\n${conversationHistory
            .map((t) => {
              const car = t.codingAgentResponse ?? "(no response captured)";
              const fb = t.judgeFeedback;
              return `### Iteration ${t.iteration}\n- **Coding agent response**: ${car.substring(0, 500)}${car.length > 500 ? "..." : ""}\n- **Your previous feedback**: ${fb.substring(0, 500)}${fb.length > 500 ? "..." : ""}\n- **Passed**: ${t.passed}`;
            })
            .join("\n\n")}`
        : "";

    return `Evaluate the workspace against ALL criteria below. Use the file tools to inspect the code, then provide your verdict in JSON format.

## Criteria
${criteriaList}${historySection}`;
  }

  private parseJsonResponse(
    response: string,
    criteria: CriteriaConfig[],
    onProgress?: (result: CriterionResult) => void,
  ): DetailedEvaluationResult {
    // Try to extract JSON from markdown code blocks
    let jsonStr = response.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    } else {
      // Try to find raw JSON
      const rawJsonMatch = jsonStr.match(/(\{[\s\S]*\})/);
      if (rawJsonMatch) {
        jsonStr = rawJsonMatch[1];
      }
    }

    try {
      const data = JSON.parse(jsonStr);
      if (!data.results || !Array.isArray(data.results)) {
        throw new Error("Invalid JSON structure: missing results array");
      }

      const results: CriterionResult[] = [];
      const evaluatedIds = new Set<string>();

      for (const item of data.results) {
        const result: CriterionResult = {
          criterionId: item.criterion || "unknown",
          passed: item.passed === true,
          feedback: item.feedback || "",
          evaluated: true,
        };
        results.push(result);
        evaluatedIds.add(item.criterion);
        onProgress?.(result);
      }

      // Add any missing criteria as not evaluated
      for (const criterion of criteria) {
        if (!evaluatedIds.has(criterion.id)) {
          const result: CriterionResult = {
            criterionId: criterion.id,
            passed: false,
            feedback: "Not evaluated",
            evaluated: false,
          };
          results.push(result);
          onProgress?.(result);
        }
      }

      const allPassed = results.every((r) => r.passed);

      return {
        allPassed,
        results,
        evaluatedIds,
        strategy: "bundled",
      };
    } catch (error) {
      console.error("[BundledStrategy] Failed to parse JSON:", error);
      console.error("[BundledStrategy] Response was:", response);

      // Fallback: treat all as not passed
      const results: CriterionResult[] = criteria.map((c) => ({
        criterionId: c.id,
        passed: false,
        feedback: `Failed to parse judge response: ${response.substring(0, 200)}`,
        evaluated: false,
      }));

      return {
        allPassed: false,
        results,
        evaluatedIds: new Set(),
        strategy: "bundled",
      };
    }
  }
}

/**
 * IndependentStrategy: Evaluate criteria separately in topological order
 *
 * - Evaluates ready criteria in parallel (up to maxParallelism)
 * - Skips descendants of failed criteria
 * - Each criterion gets its own session with PASS/FAIL response
 */
export class IndependentStrategy extends JudgeStrategy {
  private maxParallelism: number;

  constructor(model?: string, maxParallelism: number = 3) {
    super(model);
    this.maxParallelism = maxParallelism;
  }

  async evaluate(
    context: JudgeStrategyContext
  ): Promise<DetailedEvaluationResult> {
    const {
      workspacePath,
      criteria,
      criteriaGraph,
      conversationHistory,
      personaInstructions,
      onProgress,
      gate,
      trajectory,
    } = context;

    // Get topological order
    const topoOrder = criteriaGraph.topologicalSort();
    const criteriaIds = new Set(criteria.map((c) => c.id));
    const criteriaById = new Map(criteria.map((c) => [c.id, c]));

    // Track state
    const results: CriterionResult[] = [];
    const failedIds = new Set<string>();
    const evaluatedIds = new Set<string>();
    let pending = new Set(criteriaIds);

    let evalIndex = 0;

    // Process in waves
    while (pending.size > 0) {
      // Find ready and skipped criteria
      const ready: string[] = [];
      const toSkip: string[] = [];

      for (const cid of Array.from(pending)) {
        const ancestors = criteriaGraph.getAncestors(cid);
        const ancestorsInSet = new Set(
          Array.from(ancestors).filter((a) => criteriaIds.has(a))
        );

        // Check if any ancestor failed
        const hasFailedAncestor = Array.from(ancestorsInSet).some((a) =>
          failedIds.has(a)
        );

        if (hasFailedAncestor) {
          toSkip.push(cid);
        } else if (
          Array.from(ancestorsInSet).every((a) => evaluatedIds.has(a))
        ) {
          ready.push(cid);
        }
      }

      // Skip criteria with failed ancestors
      for (const cid of toSkip) {
        const result: CriterionResult = {
          criterionId: cid,
          passed: false,
          feedback: "Skipped: ancestor criterion failed",
          evaluated: false,
        };
        results.push(result);
        pending.delete(cid);
        onProgress?.(result);
      }

      // Evaluate ready batch in parallel
      if (ready.length > 0) {
        const batch = ready.slice(0, this.maxParallelism);
        const promises = batch.map((cid) =>
          this.evaluateSingleCriterion(
            workspacePath,
            criteriaById.get(cid)!,
            conversationHistory,
            personaInstructions,
            evalIndex++,
            gate,
            trajectory
          )
        );

        const batchResults = await Promise.all(promises);

        for (const result of batchResults) {
          results.push(result);
          evaluatedIds.add(result.criterionId);
          if (!result.passed) {
            failedIds.add(result.criterionId);
          }
          pending.delete(result.criterionId);
          onProgress?.(result);
        }
      } else if (toSkip.length === 0) {
        // No ready and no skipped - shouldn't happen but break to prevent infinite loop
        console.warn(
          "[IndependentStrategy] No ready or skipped criteria, breaking loop"
        );
        break;
      }
    }

    const allPassed = results.every((r) => r.passed);

    return {
      allPassed,
      results,
      evaluatedIds,
      strategy: "independent",
    };
  }

  private async evaluateSingleCriterion(
    workspacePath: string,
    criterion: CriteriaConfig,
    conversationHistory: ConversationTurn[],
    personaInstructions: string | undefined,
    index: number,
    gate?: GateId,
    trajectory?: AgentTrajectory
  ): Promise<CriterionResult> {
    const systemPrompt = this.buildSystemPrompt(
      personaInstructions,
      !!trajectory && trajectory.calls.length > 0
    );

    const userPrompt = this.buildUserPrompt(criterion, conversationHistory);

    try {
      const response = await this.runCopilotSession(
        workspacePath,
        systemPrompt,
        userPrompt,
        trajectory
      );

      const passed = this.detectPassFail(response);
      const feedback = response
        .trim()
        .replace(/^(PASS|FAIL):\s*/i, "")
        .trim();

      return {
        criterionId: criterion.id,
        passed,
        feedback,
        evaluated: true,
      };
    } catch (error) {
      return {
        criterionId: criterion.id,
        passed: false,
        feedback: `Evaluation error: ${error instanceof Error ? error.message : String(error)}`,
        evaluated: false,
      };
    }
  }

  /**
   * Builds the invariant system prompt (role, persona, tools, judging method,
   * instructions, output format). It does NOT contain the criterion or the
   * previous-iteration history — those are per-request data carried by the user
   * prompt (see {@link buildUserPrompt}) so the system prompt stays identical
   * across every criterion and iteration in a run.
   */
  protected buildSystemPrompt(
    personaInstructions?: string,
    hasTrajectory?: boolean
  ): string {
    const personaSection = personaInstructions
      ? `\n## Persona\n${personaInstructions}\n`
      : "";

    const toolOutputsSection = hasTrajectory
      ? `\n${TRAJECTORY_GUIDANCE}\n`
      : "";

    return `You are an expert code reviewer evaluating the tool calls, logs and generated code produced by a coding agent against ONE specific criterion.
${personaSection}
## What to Evaluate
Evaluate the coding agent's work — its generated code together with the captured outputs of the tools it ran — against the criterion provided in the user message.
${toolOutputsSection}
## Instructions
1. Gather evidence from both the workspace and the coding agent's captured tool outputs.
2. Determine if the criterion is met (PASS) or not met (FAIL).
3. Provide specific feedback about what you found.

## Output Format
**CRITICAL**: The FIRST LINE of your response MUST be exactly "PASS:" or "FAIL:" (nothing else on that line).
Then provide your explanation on subsequent lines.

Example:
PASS:
The workspace contains a package.json file with express listed as a dependency (version 4.18.0).

Or:
FAIL:
No package.json file was found in the workspace root.`;
  }

  /**
   * Builds the per-request user prompt: the single criterion to evaluate plus
   * any previous-iteration context. This is the data the (invariant) system
   * prompt refers to.
   */
  protected buildUserPrompt(
    criterion: CriteriaConfig,
    conversationHistory: ConversationTurn[]
  ): string {
    const historySection =
      conversationHistory.length > 0
        ? `\n\n## Previous Iterations (for context)\n${conversationHistory
            .map((t) => {
              const car = t.codingAgentResponse ?? "(no response captured)";
              return `### Iteration ${t.iteration}\n- **Coding agent response**: ${car.substring(0, 300)}${car.length > 300 ? "..." : ""}\n- **Passed**: ${t.passed}`;
            })
            .join("\n\n")}`
        : "";

    return `Evaluate criterion "${criterion.id}": ${criterion.prompt}${historySection}`;
  }

  private detectPassFail(response: string): boolean {
    const lines = response.trim().split("\n");
    const firstLines = lines.slice(0, 3).join("\n").toUpperCase();

    // Look for PASS or FAIL patterns (with optional markdown formatting)
    const passMatch = firstLines.match(
      /(?:^|\*\*|##\s*)\s*PASS\s*(?:\*\*)?:?/
    );
    const failMatch = firstLines.match(
      /(?:^|\*\*|##\s*)\s*FAIL\s*(?:\*\*)?:?/
    );

    if (passMatch && failMatch) {
      // Both found - whichever comes first wins
      return passMatch.index! < failMatch.index!;
    }

    if (passMatch) {
      return true;
    }

    // Default to fail if no clear signal
    return false;
  }
}

/**
 * Factory function to create a judge strategy
 */
export function createJudgeStrategy(
  type: "bundled" | "independent",
  config?: { model?: string; maxParallelism?: number }
): JudgeStrategy {
  if (type === "independent") {
    return new IndependentStrategy(config?.model, config?.maxParallelism);
  }
  return new BundledStrategy(config?.model);
}
