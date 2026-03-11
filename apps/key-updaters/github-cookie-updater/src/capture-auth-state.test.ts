// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { resolveOutputPath, ensureDir, DEFAULT_OUTPUT } from "./capture-auth-state.js";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("resolveOutputPath", () => {
  it("returns the default when no CLI arg is provided", () => {
    expect(resolveOutputPath(["node", "script.ts"])).toBe(DEFAULT_OUTPUT);
  });

  it("returns the CLI arg when provided", () => {
    expect(resolveOutputPath(["node", "script.ts", "/tmp/custom.json"])).toBe("/tmp/custom.json");
  });

  it("default output matches .auth/github-storage.json", () => {
    expect(DEFAULT_OUTPUT).toBe(".auth/github-storage.json");
  });
});

describe("ensureDir", () => {
  const testBase = join(tmpdir(), "capture-auth-state-test-" + Date.now());

  it("creates the parent directory if it does not exist", () => {
    const filePath = join(testBase, "nested", "dir", "file.json");
    ensureDir(filePath);
    expect(existsSync(join(testBase, "nested", "dir"))).toBe(true);
    rmSync(testBase, { recursive: true, force: true });
  });

  it("does not throw if the directory already exists", () => {
    mkdirSync(testBase, { recursive: true });
    const filePath = join(testBase, "file.json");
    expect(() => ensureDir(filePath)).not.toThrow();
    rmSync(testBase, { recursive: true, force: true });
  });
});
