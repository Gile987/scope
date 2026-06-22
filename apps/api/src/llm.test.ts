// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock isUnexpected so our fake responses are always treated as success.
vi.mock("@azure-rest/ai-inference", () => ({
  isUnexpected: () => false,
}));

// Mock the inference client acquisition; the per-test `postSpy` drives responses.
const postSpy = vi.fn();
vi.mock("./llm-token.js", () => ({
  acquireInferenceClient: vi.fn(async () => ({
    client: { path: () => ({ post: postSpy }) },
    model: "test-model",
  })),
  isLlmAvailable: () => true,
}));

import { generateCriteriaPrompt, type ExistingCriterion } from "./llm.js";

/** Wrap a JSON payload in the chat-completions response envelope. */
function reply(payload: unknown) {
  return { body: { choices: [{ message: { content: JSON.stringify(payload) } }] } };
}

/** Classify a request by its system prompt so the mock can branch. */
function kindOf(body: any): "author" | "parents" | "children" {
  const system: string = body.messages[0].content;
  if (system.includes("writing evaluation criteria")) return "author";
  // Suggestion prompts embed the directional relationship wording.
  if (system.includes("PREREQUISITES of the new criterion")) return "parents";
  return "children";
}

beforeEach(() => {
  postSpy.mockReset();
});

describe("generateCriteriaPrompt — gate-aware suggestions", () => {
  const existing: ExistingCriterion[] = [
    { id: "build_a", prompt: "build a", gates: ["select", "build"] },
    { id: "select_b", prompt: "select b", gates: ["select"] },
    { id: "test_c", prompt: "test c", gates: ["select", "build", "test"] },
  ];

  it("splits parent/child pools by the gate invariant", async () => {
    const seen: Record<string, string[]> = { parents: [], children: [] };
    postSpy.mockImplementation(async ({ body }: any) => {
      const kind = kindOf(body);
      if (kind === "author") return reply({ prompt: "p", suggestedId: "new_one" });
      // Record which candidate ids were offered to each suggestion call.
      const ids = (body.messages[1].content.match(/^- (\w+):/gm) ?? []).map((l: string) =>
        l.replace(/^- (\w+):.*/, "$1"),
      );
      seen[kind] = ids;
      return reply({ suggestions: [] });
    });

    // New criterion at ["select", "build"]: a parent must be compatible with
    // both gates (gates ⊇ {select,build}); a child must be a subset.
    await generateCriteriaPrompt("behave", existing, ["select", "build"]);

    // Parents: build_a ({select,build} ⊇) and test_c ({select,build,test} ⊇). Not select_b.
    expect(seen.parents.sort()).toEqual(["build_a", "test_c"]);
    // Children: build_a ({select,build} ⊆) and select_b ({select} ⊆). Not test_c.
    expect(seen.children.sort()).toEqual(["build_a", "select_b"]);
  });

  it("post-filters model suggestions outside the pool", async () => {
    postSpy.mockImplementation(async ({ body }: any) => {
      const kind = kindOf(body);
      if (kind === "author") return reply({ prompt: "p", suggestedId: "x" });
      if (kind === "parents") return reply({ suggestions: ["build_a", "select_b"] }); // select_b not a valid parent
      return reply({ suggestions: ["select_b", "test_c"] }); // test_c not a valid child
    });

    const res = await generateCriteriaPrompt("behave", existing, ["select", "build"]);

    expect(res.suggestedParents).toEqual(["build_a"]);
    expect(res.suggestedChildren).toEqual(["select_b"]);
  });

  it("issues all three calls in parallel", async () => {
    postSpy.mockImplementation(async ({ body }: any) => {
      const kind = kindOf(body);
      if (kind === "author") return reply({ prompt: "p", suggestedId: "x" });
      return reply({ suggestions: [] });
    });

    await generateCriteriaPrompt("behave", existing, ["select"]);
    expect(postSpy).toHaveBeenCalledTimes(3);
  });

  it("degrades a failed suggestion call to [] without failing generation", async () => {
    postSpy.mockImplementation(async ({ body }: any) => {
      const kind = kindOf(body);
      if (kind === "author") return reply({ prompt: "authored", suggestedId: "x" });
      if (kind === "children") throw new Error("boom");
      return reply({ suggestions: ["build_a"] });
    });

    const res = await generateCriteriaPrompt("behave", existing, ["select", "build"]);

    expect(res.prompt).toBe("authored");
    expect(res.suggestedParents).toEqual(["build_a"]);
    expect(res.suggestedChildren).toEqual([]);
  });

  it("throws when the author call fails", async () => {
    postSpy.mockImplementation(async ({ body }: any) => {
      const kind = kindOf(body);
      if (kind === "author") throw new Error("author down");
      return reply({ suggestions: [] });
    });

    await expect(generateCriteriaPrompt("behave", existing, ["select"])).rejects.toThrow("author down");
  });

  it("uses the full list for both pools when gates are omitted (backward compatible)", async () => {
    const seen: Record<string, number> = { parents: 0, children: 0 };
    postSpy.mockImplementation(async ({ body }: any) => {
      const kind = kindOf(body);
      if (kind === "author") return reply({ prompt: "p", suggestedId: "x" });
      seen[kind] = (body.messages[1].content.match(/^- /gm) ?? []).length;
      return reply({ suggestions: [] });
    });

    await generateCriteriaPrompt("behave", existing);

    expect(seen.parents).toBe(existing.length);
    expect(seen.children).toBe(existing.length);
  });
});
