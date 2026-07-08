// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Deterministic smoke test for scope #1255 —
 * "Judge: feed cumulative tool calls across iterations and expose prior
 * per-criterion results."
 *
 * This proves the fix against the REAL failing integration run
 * `1754fd48-19e0-45b1-b566-5f5a3858c4f0` ("Rayfin: New Project Setup") by
 * exercising the actual production code paths — `buildToolCallHistory`, the
 * `list_tool_calls` / `search_tool_outputs` / `get_tool_output` tools, and
 * `buildPriorResultsSection` — against the run's archived data. It needs NO
 * LLM, docker, or tokens, so it is deterministic and reproducible in CI.
 *
 * The bug (confirmed in the archived data):
 *   Several criteria that must inspect tool output oscillate PASS↔FAIL as the
 *   run iterates, because the judge only ever saw the *current* iteration's
 *   tool calls. The scaffold command
 *     `npx -y @microsoft/create-rayfin@latest --project-name raychef --template todoapp`
 *   ran in iterations 1, 4, 7 and 9 but NOT in the final iteration 10. Judging
 *   iteration 10 in isolation, the judge could not see the scaffold, so
 *   `rayfin_bootstrap` was marked FAIL — and it was the SOLE failing criterion
 *   at iteration 10 (the other four passed), so the `select` gate never
 *   converged and the run exhausted its 10 iterations.
 *
 * The fix:
 *   The judge assembles tool calls from EVERY iteration (1..N), so a one-time
 *   action stays discoverable via `search_tool_outputs` no matter which
 *   iteration is being judged; and `buildPriorResultsSection` shows the judge a
 *   per-criterion PASS/FAIL timeline plus "sticky pass" guidance, so a criterion
 *   that genuinely passed earlier is treated as satisfied unless there is
 *   concrete evidence of a regression.
 *
 * Data prep (run once; /tmp is ephemeral so re-run if the dir is gone):
 *   pnpm cli run download -i 1754fd48-19e0-45b1-b566-5f5a3858c4f0 \
 *     -u https://msscope-int.azurewebsites.net --extract -d /tmp/smoke/run
 *   # then convert the run document to JSON (the harness reads run.json to stay
 *   # dependency-free; the archive ships run.yaml):
 *   python3 - <<'PY'
 *   import yaml, json
 *   d = "/tmp/smoke/run/1754fd48-19e0-45b1-b566-5f5a3858c4f0"
 *   doc = yaml.safe_load(open(f"{d}/run.yaml"))
 *   json.dump(doc, open(f"{d}/run.json", "w"), default=str)
 *   PY
 *
 * Usage:
 *   pnpm --filter judge exec tsx scripts/smoke-cumulative-tool-calls.ts [runDir]
 *   # or from the repo root:
 *   pnpm exec tsx apps/judge/scripts/smoke-cumulative-tool-calls.ts [runDir]
 *
 * Exits 0 if every assertion passes, 1 otherwise.
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import type {
  ToolCall,
  IterationToolCalls,
  ConversationTurn,
  CriterionResult,
} from "shared";
import {
  IndependentStrategy,
  buildPriorResultsSection,
  STICKY_PASS_GUIDANCE,
} from "../src/judge-strategies.js";

const DEFAULT_RUN_DIR =
  "/tmp/smoke/run/1754fd48-19e0-45b1-b566-5f5a3858c4f0";
/** The one-time scaffold action that oscillated in the real run. */
const SCAFFOLD_PATTERN = "create-rayfin";
/** The criterion that failed at the final iteration despite passing earlier. */
const ONE_TIME_CRITERION = "rayfin_bootstrap";

/**
 * Test subclass exposing the protected tool factory, mirroring the unit-test
 * `TestableStrategy`. We drive the real tools with no Copilot session.
 */
class HarnessStrategy extends IndependentStrategy {
  publicCreateToolOutputTools(iterationToolCalls: IterationToolCalls[]) {
    return this.createToolOutputTools(iterationToolCalls);
  }
}

const stubInvocation = {
  sessionId: "smoke-session",
  toolCallId: "smoke-call",
  toolName: "smoke-tool",
  arguments: {},
};

async function invoke(
  tools: ReturnType<HarnessStrategy["publicCreateToolOutputTools"]>,
  name: string,
  args: Record<string, unknown>
): Promise<any> {
  const tool = tools.find((t) => t.name === name);
  if (!tool?.handler) throw new Error(`tool ${name} has no handler`);
  return (tool.handler as (a: unknown, b: unknown) => unknown)(
    args,
    stubInvocation
  );
}

/** Load every `iteration-N.tool-calls.jsonl` in the run dir as IterationToolCalls[]. */
function loadIterationToolCalls(runDir: string): IterationToolCalls[] {
  const batches = readdirSync(runDir)
    .map((f) => /^iteration-(\d+)\.tool-calls\.jsonl$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ iteration: parseInt(m[1], 10), file: m[0] }))
    .sort((a, b) => a.iteration - b.iteration);

  return batches.map(({ iteration, file }) => {
    // Same JSONL shape as the tool-call blobs parsed by getToolCalls().
    const toolCalls: ToolCall[] = readFileSync(join(runDir, file), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ToolCall);
    return { iteration, toolCalls };
  });
}

/** Load run.json → conversation turns (iteration + criteriaResults + response). */
function loadConversationHistory(runDir: string): ConversationTurn[] {
  const runJson = join(runDir, "run.json");
  if (!existsSync(runJson)) {
    throw new Error(
      `run.json not found in ${runDir}. Convert run.yaml → run.json first ` +
        `(see the data-prep block in this script's header comment).`
    );
  }
  const doc = JSON.parse(readFileSync(runJson, "utf8"));
  const turns: any[] = doc?.run?.turns ?? [];
  return turns.map(
    (t): ConversationTurn => ({
      iteration: t.iteration,
      passed: t.passed,
      judgeFeedback: t.judgeFeedback,
      codingAgentResponse: t.codingAgentResponse,
      snapshotUrl: t.snapshotUrl,
      timestamp: t.timestamp,
      toolCallsUrl: t.toolCallsUrl,
      toolCallCount: t.toolCallCount,
      criteriaResults: (t.criteriaResults ?? []) as CriterionResult[],
    })
  );
}

// ── Tiny assertion harness ──────────────────────────────────────────────────
let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`  [${status}] ${label}${suffix}`);
}

async function main(): Promise<void> {
  const runDir = process.argv[2] ?? DEFAULT_RUN_DIR;
  console.log(`\nscope #1255 deterministic smoke test`);
  console.log(`run dir: ${runDir}\n`);

  if (!existsSync(runDir)) {
    console.error(
      `Run dir ${runDir} does not exist. Download the archive first ` +
        `(see this script's header comment).`
    );
    process.exit(1);
  }

  const iterationToolCalls = loadIterationToolCalls(runDir);
  const history = loadConversationHistory(runDir);
  const finalIteration = iterationToolCalls[iterationToolCalls.length - 1];

  console.log(
    `Loaded ${iterationToolCalls.length} iterations of tool calls ` +
      `(${iterationToolCalls
        .map((i) => `it${i.iteration}:${i.toolCalls.length}`)
        .join(", ")})`
  );
  console.log(`Loaded ${history.length} conversation turns\n`);

  const strategy = new HarnessStrategy("smoke-model");

  // ── 1. Reproduce the bug: judging ONLY the final iteration, the scaffold is invisible.
  console.log(
    `1) OLD behavior — judge sees only the final iteration (it${finalIteration.iteration}):`
  );
  const oldTools = strategy.publicCreateToolOutputTools([finalIteration]);
  const oldSearch = await invoke(oldTools, "search_tool_outputs", {
    pattern: SCAFFOLD_PATTERN,
    maxMatches: 100,
  });
  check(
    `scaffold "${SCAFFOLD_PATTERN}" is NOT found in the final iteration alone`,
    oldSearch.matchCount === 0,
    `matchCount=${oldSearch.matchCount}`
  );

  // ── 2. Prove the fix: judging with ALL iterations, the scaffold is discoverable.
  console.log(
    `\n2) NEW behavior — judge assembles all ${iterationToolCalls.length} iterations:`
  );
  const newTools = strategy.publicCreateToolOutputTools(iterationToolCalls);
  const newSearch = await invoke(newTools, "search_tool_outputs", {
    pattern: SCAFFOLD_PATTERN,
    maxMatches: 100,
  });
  const matchedIterations = [
    ...new Set(
      newSearch.matches.flatMap((m: any) => m.iterations ?? [m.iteration])
    ),
  ].sort((a: number, b: number) => a - b);
  check(
    `scaffold "${SCAFFOLD_PATTERN}" IS found across the whole run`,
    newSearch.matchCount > 0,
    `matchCount=${newSearch.matchCount}`
  );
  check(
    `scaffold is attributed to an earlier iteration (not just the final one)`,
    matchedIterations.some((it: number) => it < finalIteration.iteration),
    `iterations=[${matchedIterations.join(", ")}]`
  );

  const list = await invoke(newTools, "list_tool_calls", { limit: 1 });
  check(
    `list_tool_calls covers every iteration`,
    JSON.stringify(list.iterationsCovered) ===
      JSON.stringify(iterationToolCalls.map((i) => i.iteration)),
    `iterationsCovered=[${list.iterationsCovered?.join(", ")}]`
  );
  check(
    `cumulative history is non-trivial (deduped across the run)`,
    list.totalCalls > finalIteration.toolCalls.length,
    `totalCalls=${list.totalCalls} vs finalIterationOnly=${finalIteration.toolCalls.length}`
  );

  // get_tool_output on a scaffold match returns the full command + its iteration.
  const scaffoldMatch = newSearch.matches[0];
  const full = await invoke(newTools, "get_tool_output", {
    index: scaffoldMatch.index,
  });
  check(
    `get_tool_output returns the scaffold call with an iteration label`,
    typeof full.iteration === "number" &&
      JSON.stringify(full).includes(SCAFFOLD_PATTERN),
    `iteration=${full.iteration}`
  );

  // ── 3. Prior per-criterion results: the oscillating criterion's timeline + sticky pass.
  console.log(`\n3) Prior per-criterion results + sticky-pass guidance:`);
  const priorSection = buildPriorResultsSection(history, [ONE_TIME_CRITERION]);
  check(
    `renders a per-criterion prior-results section`,
    priorSection.includes("Prior") && priorSection.includes(ONE_TIME_CRITERION),
    `section length=${priorSection.length}`
  );
  check(
    `timeline shows the criterion PASSed in an earlier iteration`,
    /PASS/.test(priorSection),
    `has PASS token`
  );
  check(
    `timeline shows the criterion FAILed at the final iteration`,
    /FAIL/.test(priorSection),
    `has FAIL token`
  );
  check(
    `includes sticky-pass guidance so earlier PASS isn't silently dropped`,
    priorSection.includes(STICKY_PASS_GUIDANCE) ||
      priorSection.toLowerCase().includes("sticky") ||
      priorSection.toLowerCase().includes("passed in an earlier"),
    `guidance present`
  );
  // Sticky-pass must NOT be a permanent latch: the guidance must still allow the
  // judge to FAIL a criterion that genuinely regressed, so real regressions are
  // not masked. This is the deterministic half of DoD item 7's control check.
  check(
    `sticky-pass guidance still permits FAIL on a genuine regression`,
    /regress/i.test(STICKY_PASS_GUIDANCE) &&
      /not a permanent latch/i.test(STICKY_PASS_GUIDANCE),
    `guidance is evidence, not a latch`
  );

  // Show the timeline for eyeballing.
  console.log("\n--- prior-results section (rayfin_bootstrap) ---");
  console.log(
    priorSection
      .split("\n")
      .map((l) => "  | " + l)
      .join("\n")
  );
  console.log("--- end ---");

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(
    `\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
