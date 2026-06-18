// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * End-to-end judge evaluation integration test.
 *
 * Exercises the FULL evaluation path exactly as production does for
 * POST /api/v1/evaluate: filesystem criteria provider -> criteria DAG ->
 * judge strategy -> REAL CopilotClient (bundled CLI + ACP protocol
 * handshake) -> session.sendAndWait() LLM call -> verdict + feedback.
 *
 * This is the path that returned HTTP 500 in growth-ecosystems/scope-doc#64
 * (the SDK<->CLI protocol mismatch surfaced inside CopilotClient.start()),
 * so a real evaluation is the strongest end-to-end regression guard: it
 * fails if the bundled CLI drifts from the SDK, if auth breaks, or if the
 * strategy/criteria/feedback wiring regresses.
 *
 * Requires GITHUB_TOKEN (copilot scope). TokenManagerClient falls back to
 * GITHUB_TOKEN when TOKEN_MANAGER_URL is unset, so no token-manager service
 * is needed. The test is skipped automatically when GITHUB_TOKEN is absent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetCriteriaProvider } from "shared/criteria-provider-factory";
import { evaluateWorkspace } from "./judge-agent.js";

const hasToken = !!process.env.GITHUB_TOKEN;

/**
 * The judge runs real LLM sessions, so the model must be one the test
 * credential is entitled to. The default `gpt-4.1` is frequently unavailable;
 * allow CI to override and otherwise pick a broadly-available model.
 */
const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-opus-4.6";

describe("judge end-to-end evaluation (integration)", () => {
  let workspaceDir: string;
  let criteriaDir: string;
  const saved: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  beforeAll(() => {
    // realpathSync resolves the macOS /var/folders -> /private/var symlink so
    // the judge's workspace file tools see a stable, canonical root.
    workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "judge-ws-")));
    criteriaDir = realpathSync(mkdtempSync(join(tmpdir(), "judge-criteria-")));

    // A trivially, deterministically true workspace + criterion.
    writeFileSync(join(workspaceDir, "hello.txt"), "Hello, World!\n");
    writeFileSync(
      join(criteriaDir, "has_hello_file.yaml"),
      [
        "id: has_hello_file",
        "prompt: |",
        "  The workspace contains a file named hello.txt whose contents are",
        "  exactly the text 'Hello, World!'.",
        "",
      ].join("\n")
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
    "evaluates a workspace against criteria via the real Copilot SDK and returns a real verdict",
    { timeout: 300_000 },
    async () => {
      // The primary guard for scope-doc#64: a healthy judge runs the full
      // pipeline and returns a real, evaluated verdict instead of throwing an
      // infrastructure error (which is what the SDK<->CLI protocol mismatch did).
      const result = await evaluateWorkspace({
        workspacePath: workspaceDir,
        criteria: ["has_hello_file"],
        conversationHistory: [],
      });

      expect(typeof result.passed).toBe("boolean");
      expect(typeof result.feedback).toBe("string");
      expect(result.feedback.length).toBeGreaterThan(0);
      expect(result.criteriaResults.length).toBeGreaterThanOrEqual(1);

      const hello = result.criteriaResults.find((r) => r.criterionId === "has_hello_file");
      expect(hello, "has_hello_file result missing").toBeTruthy();
      // `evaluated: true` means the SDK session actually produced a verdict for
      // the criterion (not skipped, not errored) — the strongest health signal.
      expect(hello!.evaluated).toBe(true);
      expect(typeof hello!.passed).toBe("boolean");
      expect(hello!.feedback.length).toBeGreaterThan(0);

      // The criterion is trivially, verifiably true. A healthy judge inspects the
      // workspace with its file tools and passes it. If this fails, the judge
      // could not actually read the workspace — which is exactly the regression
      // scope-doc#64 is about (SDK<->CLI protocol break, then headless tool-
      // permission denial under the v3 SDK). Treat it as a hard failure.
      expect(
        hello!.passed,
        `judge failed a trivially-true criterion (workspace inspection likely broken). Feedback: ${hello!.feedback}`
      ).toBe(true);
      expect(result.passed).toBe(true);
    }
  );

  it("logs a skip note when GITHUB_TOKEN is absent (no real evaluation possible)", () => {
    if (!hasToken) {
      console.warn(
        "[integration] GITHUB_TOKEN not set — end-to-end judge evaluation skipped"
      );
    }
    expect(true).toBe(true);
  });
});
