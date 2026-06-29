// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ATIF-trajectory observation acceptance test (issue #1156, acceptance step 3).
 *
 * Proves the judge resolves a trajectory-only observation — one whose answer is
 * NOT derivable from the final workspace snapshot — by consuming the agent's
 * ATIF trajectory that pp-taxonomy forwards as a synthetic `agent_trajectory_atif`
 * tool call (see apps/judge/src/index.ts). The canonical case is
 * `dependency_added_then_removed`: a package is installed then uninstalled mid-run,
 * so it is invisible in the end-state snapshot and only the trajectory reveals it.
 *
 * Two assertions form the acceptance:
 *   1. WITH the trajectory tool call → criterion resolves passed:true (the judge
 *      actually consumed the ATIF).
 *   2. WITHOUT the trajectory (snapshot only) → the same criterion flips to
 *      passed:false, proving the verdict comes from the trajectory, not the files.
 *
 * Exercises the REAL Copilot SDK, so it requires GITHUB_TOKEN (copilot scope) and
 * is skipped automatically when the token is absent — mirroring
 * judge-evaluation.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetCriteriaProvider } from "shared/criteria-provider-factory";
import type { ToolCall } from "shared";
import { evaluateWorkspace } from "./judge-agent.js";

const hasToken = !!process.env.GITHUB_TOKEN;
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-5.4-mini";

/**
 * Synthetic ATIF trajectory mirroring what pp-taxonomy forwards: the agent
 * installs `left-pad`, uses it, then uninstalls it before finishing. The final
 * package.json (below) therefore does NOT list left-pad.
 */
const ATIF_TRAJECTORY = {
  schema: "atif/1",
  steps: [
    { type: "tool_call", name: "run_in_terminal", arguments: { command: "npm install left-pad" }, response: "+ left-pad@1.3.0\nadded 1 package" },
    { type: "tool_call", name: "edit_file", arguments: { path: "index.js" }, response: "require('left-pad')" },
    { type: "tool_call", name: "run_in_terminal", arguments: { command: "npm uninstall left-pad" }, response: "removed 1 package" },
  ],
};

const TRAJECTORY_TOOL_CALL: ToolCall = {
  id: "atif-trajectory",
  name: "agent_trajectory_atif",
  arguments: {},
  response: JSON.stringify(ATIF_TRAJECTORY),
};

describe("judge ATIF-trajectory observation (integration)", () => {
  let workspaceDir: string;
  let criteriaDir: string;
  const saved: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  beforeAll(() => {
    workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "judge-atif-ws-")));
    criteriaDir = realpathSync(mkdtempSync(join(tmpdir(), "judge-atif-crit-")));

    // End-state snapshot: package.json WITHOUT left-pad. The add-then-remove is
    // invisible here; only the trajectory reveals it.
    writeFileSync(
      join(workspaceDir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", dependencies: {} }, null, 2) + "\n",
    );
    writeFileSync(join(workspaceDir, "index.js"), "console.log('hello');\n");

    // Observation criterion (matches config/criteria/dependency_added_then_removed.yaml).
    writeFileSync(
      join(criteriaDir, "dependency_added_then_removed.yaml"),
      [
        "id: dependency_added_then_removed",
        "kind: observation",
        "taxonomy_element_id: dimension:dependency-currency",
        "prompt: |",
        "  During the run the agent installed a package and later uninstalled or",
        "  removed it before finishing (e.g. added left-pad then removed it). This",
        "  is only derivable from the agent's trajectory (mid-run tool calls), not",
        "  from the final codebase snapshot, because the dependency is absent in the",
        "  end state. Inspect the agent_trajectory_atif tool output to detect a",
        "  transient add-then-remove.",
        "",
      ].join("\n"),
    );

    setEnv("CRITERIA_DIR", criteriaDir);
    setEnv("JUDGE_STRATEGY", process.env.JUDGE_STRATEGY || "independent");
    setEnv("JUDGE_MODEL", JUDGE_MODEL);
    setEnv("FEEDBACK_MODEL", process.env.FEEDBACK_MODEL || JUDGE_MODEL);
    resetCriteriaProvider();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetCriteriaProvider();
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(criteriaDir, { recursive: true, force: true });
  });

  it.skipIf(!hasToken)(
    "resolves a trajectory-only observation true WITH the ATIF, false WITHOUT it",
    { timeout: 600_000 },
    async () => {
      // (1) WITH the ATIF trajectory tool call → the agent's add-then-remove is
      // visible, so the observation must resolve true.
      const withAtif = await evaluateWorkspace({
        workspacePath: workspaceDir,
        criteria: ["dependency_added_then_removed"],
        conversationHistory: [],
        toolCalls: [TRAJECTORY_TOOL_CALL],
      });

      const obsWith = withAtif.criteriaResults.find(
        (r) => r.criterionId === "dependency_added_then_removed",
      );
      expect(obsWith, "observation result missing (with ATIF)").toBeTruthy();
      expect(obsWith!.evaluated).toBe(true);
      expect(
        obsWith!.passed,
        `expected trajectory-only observation to pass WITH ATIF. Feedback: ${obsWith!.feedback}`,
      ).toBe(true);

      // (2) WITHOUT the ATIF (snapshot only) → the add-then-remove is invisible
      // in the end state, so the same observation must flip to false. This proves
      // the verdict was driven by the trajectory, not the workspace files.
      const withoutAtif = await evaluateWorkspace({
        workspacePath: workspaceDir,
        criteria: ["dependency_added_then_removed"],
        conversationHistory: [],
      });

      const obsWithout = withoutAtif.criteriaResults.find(
        (r) => r.criterionId === "dependency_added_then_removed",
      );
      expect(obsWithout, "observation result missing (without ATIF)").toBeTruthy();
      expect(obsWithout!.evaluated).toBe(true);
      expect(
        obsWithout!.passed,
        `expected trajectory-only observation to FAIL without ATIF (snapshot has no left-pad). Feedback: ${obsWithout!.feedback}`,
      ).toBe(false);
    },
  );

  it("logs a skip note when GITHUB_TOKEN is absent (no real evaluation possible)", () => {
    if (!hasToken) {
      console.warn(
        "[integration] GITHUB_TOKEN not set — ATIF-trajectory observation test skipped",
      );
    }
    expect(true).toBe(true);
  });
});
