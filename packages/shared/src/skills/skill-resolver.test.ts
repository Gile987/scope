// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { encodeGitHubPath } from "./skill-resolver.js";

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
