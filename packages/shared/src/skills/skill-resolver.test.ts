// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeGitHubPath, SkillResolver } from "./skill-resolver.js";

describe("encodeGitHubPath", () => {
  it("keeps slashes literal while encoding segments", () => {
    expect(encodeGitHubPath("skills/azure-ai/SKILL.md")).toBe(
      "skills/azure-ai/SKILL.md"
    );
  });

  it("encodes special characters within segments", () => {
    expect(encodeGitHubPath("skills/my skill/SKILL.md")).toBe(
      "skills/my%20skill/SKILL.md"
    );
  });

  it("encodes hash characters in segments", () => {
    expect(encodeGitHubPath("skills/c#-best-practices/SKILL.md")).toBe(
      "skills/c%23-best-practices/SKILL.md"
    );
  });

  it("handles single-segment paths", () => {
    expect(encodeGitHubPath("SKILL.md")).toBe("SKILL.md");
  });

  it("handles deeply nested paths", () => {
    expect(encodeGitHubPath(".agents/skills/cosmosdb-best-practices/SKILL.md")).toBe(
      ".agents/skills/cosmosdb-best-practices/SKILL.md"
    );
  });

  it("handles empty prefix (root-level skill)", () => {
    expect(encodeGitHubPath("cosmosdb-best-practices/SKILL.md")).toBe(
      "cosmosdb-best-practices/SKILL.md"
    );
  });
});

// ---------------------------------------------------------------------------
// SkillResolver.discoverSkills
// ---------------------------------------------------------------------------

describe("SkillResolver.discoverSkills", () => {
  const originalFetch = globalThis.fetch;
  let resolver: SkillResolver;

  beforeEach(() => {
    resolver = new SkillResolver();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** Helper: build a Response-like stub. */
  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
  }

  it("returns skills found in the skills/ directory with frontmatter parsed", async () => {
    const skillMd = `---
name: vector-search
description: Vector search skill
---

# Vector Search`;
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      // First call: list skills/
      if (url.endsWith("/contents/skills")) {
        return jsonResponse(200, [
          { name: "vector-search", path: "skills/vector-search", type: "dir" },
          { name: "README.md", path: "skills/README.md", type: "file" },
        ]);
      }
      // Probe SKILL.md
      if (url.endsWith("/contents/skills/vector-search/SKILL.md")) {
        return jsonResponse(200, {
          content: Buffer.from(skillMd).toString("base64"),
          encoding: "base64",
        });
      }
      // Other well-known dirs return 404 (and so does the root listing)
      return jsonResponse(404, { message: "Not Found" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await resolver.discoverSkills("owner/repo");

    expect(results).toEqual([
      {
        skillName: "vector-search",
        skillPath: "skills/vector-search",
        name: "vector-search",
        description: "Vector search skill",
      },
    ]);
  });

  it("throws when the repository does not exist", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      // All directory listings 404, then repo probe also 404
      return jsonResponse(404, { message: "Not Found" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(resolver.discoverSkills("owner/missing")).rejects.toThrow(
      /Repository "owner\/missing" not found/
    );
  });

  it("returns an entry without metadata when frontmatter parsing fails", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith("/contents/skills")) {
        return jsonResponse(200, [
          { name: "broken", path: "skills/broken", type: "dir" },
        ]);
      }
      if (url.endsWith("/contents/skills/broken/SKILL.md")) {
        // Return body with no frontmatter
        return jsonResponse(200, {
          content: Buffer.from("just markdown, no frontmatter").toString("base64"),
          encoding: "base64",
        });
      }
      return jsonResponse(404, { message: "Not Found" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await resolver.discoverSkills("owner/repo");
    expect(results).toHaveLength(1);
    expect(results[0].skillName).toBe("broken");
    expect(results[0].skillPath).toBe("skills/broken");
  });

  it("deduplicates skills found in multiple well-known directories", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith("/contents/skills")) {
        return jsonResponse(200, [
          { name: "dup", path: "skills/dup", type: "dir" },
        ]);
      }
      if (url.endsWith("/contents/skills/dup/SKILL.md")) {
        return jsonResponse(200, { content: Buffer.from("# dup").toString("base64"), encoding: "base64" });
      }
      // .agents/skills also has 'dup' at a different path — should still appear (different skillPath)
      if (url.endsWith("/contents/.agents/skills")) {
        return jsonResponse(200, [
          { name: "dup", path: ".agents/skills/dup", type: "dir" },
        ]);
      }
      if (url.endsWith("/contents/.agents/skills/dup/SKILL.md")) {
        return jsonResponse(200, { content: Buffer.from("# dup").toString("base64"), encoding: "base64" });
      }
      return jsonResponse(404, { message: "Not Found" });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await resolver.discoverSkills("owner/repo");
    // Two different paths → two entries (dedupe is by path, not by skillName)
    expect(results).toHaveLength(2);
    expect(results.map(r => r.skillPath).sort()).toEqual([
      ".agents/skills/dup",
      "skills/dup",
    ]);
  });
});
