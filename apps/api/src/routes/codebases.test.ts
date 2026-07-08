// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { isValidGitSource } from "./codebases.js";

describe("isValidGitSource", () => {
  it("accepts well-formed owner/repo values", () => {
    expect(isValidGitSource("octocat/hello-world")).toBe(true);
    expect(isValidGitSource("a.b/c-d_e")).toBe(true);
    expect(isValidGitSource("Org123/Repo.js")).toBe(true);
  });

  it("rejects empty or undefined", () => {
    expect(isValidGitSource(undefined)).toBe(false);
    expect(isValidGitSource("")).toBe(false);
  });

  it("rejects values that are not exactly owner/repo", () => {
    expect(isValidGitSource("owner")).toBe(false);
    expect(isValidGitSource("owner/repo/extra")).toBe(false);
    expect(isValidGitSource("owner /repo")).toBe(false);
    expect(isValidGitSource("owner/re po")).toBe(false);
  });

  it("rejects path-traversal segments", () => {
    expect(isValidGitSource("../repo")).toBe(false);
    expect(isValidGitSource("owner/..")).toBe(false);
    expect(isValidGitSource("./x")).toBe(false);
    expect(isValidGitSource("owner/.")).toBe(false);
  });
});
