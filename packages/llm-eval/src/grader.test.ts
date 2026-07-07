// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import {
  gradeEvidenceSource,
  parseEvidenceGrade,
  EVIDENCE_SOURCE_GRADER_SYSTEM,
} from "./grader.js";
import type { ChatComplete } from "./types.js";

describe("parseEvidenceGrade", () => {
  it("parses a clean JSON reply", () => {
    expect(parseEvidenceGrade('{"source":"tool-history"}')).toBe("tool-history");
    expect(parseEvidenceGrade('{"source":"codebase"}')).toBe("codebase");
    expect(parseEvidenceGrade('{"source":"unclear"}')).toBe("unclear");
  });

  it("strips ```json fences before parsing", () => {
    expect(parseEvidenceGrade('```json\n{"source":"tool-history"}\n```')).toBe(
      "tool-history",
    );
    expect(parseEvidenceGrade('```\n{"source":"codebase"}\n```')).toBe("codebase");
  });

  it("falls back to sniffing raw text when JSON is malformed", () => {
    expect(parseEvidenceGrade("the tool-history is primary here")).toBe(
      "tool-history",
    );
    expect(parseEvidenceGrade("primarily the codebase")).toBe("codebase");
  });

  it("returns 'unclear' for unrecognized replies", () => {
    expect(parseEvidenceGrade("no idea")).toBe("unclear");
    expect(parseEvidenceGrade('{"source":"files"}')).toBe("unclear");
    expect(parseEvidenceGrade("")).toBe("unclear");
  });
});

describe("gradeEvidenceSource", () => {
  it("sends the grader system prompt + the text, and returns the parsed grade", async () => {
    const complete: ChatComplete = vi
      .fn()
      .mockResolvedValue('{"source":"tool-history"}');

    const grade = await gradeEvidenceSource(complete, "some judge prompt", {
      model: "gpt-4.1",
    });

    expect(grade).toBe("tool-history");
    expect(complete).toHaveBeenCalledTimes(1);
    const request = (complete as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(request.messages[0]).toEqual({
      role: "system",
      content: EVIDENCE_SOURCE_GRADER_SYSTEM,
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
});
