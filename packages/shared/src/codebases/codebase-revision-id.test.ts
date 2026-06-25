// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  buildCodebaseRevisionRef,
  parseCodebaseRevisionRef,
  slugifyCodebaseName,
} from "./codebase-revision-id.js";

describe("codebase revision refs", () => {
  it("builds refs as slug@rN", () => {
    expect(buildCodebaseRevisionRef("pamelafox-site", 3)).toBe("pamelafox-site@r3");
  });

  it("parses refs with revision numbers", () => {
    expect(parseCodebaseRevisionRef("pamelafox-site@r3")).toEqual({
      slug: "pamelafox-site",
      revisionNumber: 3,
    });
  });

  it("parses bare slugs as latest refs", () => {
    expect(parseCodebaseRevisionRef("pamelafox-site")).toEqual({ slug: "pamelafox-site" });
  });

  it("slugifies names for URL-safe refs", () => {
    expect(slugifyCodebaseName("Pamela Fox Site")).toBe("pamela-fox-site");
    expect(slugifyCodebaseName("  Scope: Core!! Codebases  ")).toBe("scope-core-codebases");
  });

  it("round-trips built refs through the parser", () => {
    const slug = "pamelafox-site";
    const revisionNumber = 42;
    expect(parseCodebaseRevisionRef(buildCodebaseRevisionRef(slug, revisionNumber))).toEqual({
      slug,
      revisionNumber,
    });
  });
});
