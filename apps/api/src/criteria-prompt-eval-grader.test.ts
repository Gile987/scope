// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { ChatComplete } from "llm-eval";
import {
  gradeCriteriaPrompt,
  parsePassFail,
  buildEvidenceGraderSystem,
} from "./criteria-prompt-eval-grader.js";

describe("parsePassFail", () => {
  it("parses a clean JSON reply", () => {
    expect(parsePassFail('{"pass":true}')).toBe(true);
    expect(parsePassFail('{"pass":false}')).toBe(false);
  });

  it("accepts a stringy pass value", () => {
    expect(parsePassFail('{"pass":"true"}')).toBe(true);
    expect(parsePassFail('{"pass":"PASS"}')).toBe(true);
    expect(parsePassFail('{"pass":"no"}')).toBe(false);
  });

  it("strips ```json fences before parsing", () => {
    expect(parsePassFail('```json\n{"pass":true}\n```')).toBe(true);
    expect(parsePassFail('```\n{"pass":false}\n```')).toBe(false);
  });

  it("falls back to sniffing raw text when JSON is malformed", () => {
    expect(parsePassFail("PASS")).toBe(true);
    expect(parsePassFail("this one is a fail")).toBe(false);
  });

  it("treats unrecognized or ambiguous replies as FAIL", () => {
    expect(parsePassFail("no idea")).toBe(false);
    expect(parsePassFail("could be a pass or a fail")).toBe(false);
    expect(parsePassFail("")).toBe(false);
  });
});

describe("buildEvidenceGraderSystem", () => {
  it("names the expected source as the required primary evidence", () => {
    expect(buildEvidenceGraderSystem("tool-history")).toContain(
      "CAPTURED TOOL-CALL HISTORY",
    );
    expect(buildEvidenceGraderSystem("codebase")).toContain(
      "RESULTING SOURCE FILES",
    );
    // Always pins the JSON pass/fail output contract.
    expect(buildEvidenceGraderSystem("codebase")).toContain('{"pass":true}');
  });
});

describe("gradeCriteriaPrompt", () => {
  it("sends the expected-source grader prompt + the text, and returns the pass boolean", async () => {
    const complete: ChatComplete = vi.fn().mockResolvedValue('{"pass":true}');

    const pass = await gradeCriteriaPrompt(
      complete,
      "some judge prompt",
      "tool-history",
      { model: "gpt-4.1" },
    );

    expect(pass).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    const request = (complete as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(request.messages[0]).toEqual({
      role: "system",
      content: buildEvidenceGraderSystem("tool-history"),
    });
    expect(request.messages[1]).toEqual({
      role: "user",
      content: "some judge prompt",
    });
    // Deterministic-leaning defaults so the grader reads emphasis, not noise.
    expect(request.temperature).toBe(0);
    expect(request.maxTokens).toBe(20);
    expect(request.model).toBe("gpt-4.1");
  });

  it("returns false when the grader fails the prompt", async () => {
    const complete: ChatComplete = vi.fn().mockResolvedValue('{"pass":false}');
    expect(
      await gradeCriteriaPrompt(complete, "prompt", "codebase"),
    ).toBe(false);
  });
});
