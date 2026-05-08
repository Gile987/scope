// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { createFreshArtifactsDir, cleanupArtifacts } from "./artifacts.js";

const ARTIFACTS_ROOT = "/tmp/artifacts";

describe("artifacts utilities", () => {
  afterEach(() => {
    if (existsSync(ARTIFACTS_ROOT)) {
      rmSync(ARTIFACTS_ROOT, { recursive: true, force: true });
    }
  });

  describe("createFreshArtifactsDir", () => {
    it("creates an artifacts directory under /tmp/artifacts", () => {
      const result = createFreshArtifactsDir();
      expect(result).toMatch(/^\/tmp\/artifacts\/run-[0-9a-f]{8}$/);
      expect(existsSync(result)).toBe(true);
    });

    it("cleans previous artifacts contents", () => {
      const first = createFreshArtifactsDir();
      writeFileSync(path.join(first, "iteration-1.jsonl"), "{}\n");
      expect(existsSync(first)).toBe(true);

      const second = createFreshArtifactsDir();
      expect(existsSync(second)).toBe(true);
      expect(existsSync(first)).toBe(false);
    });
  });

  describe("cleanupArtifacts", () => {
    it("removes the artifacts root directory", () => {
      createFreshArtifactsDir();
      expect(existsSync(ARTIFACTS_ROOT)).toBe(true);

      cleanupArtifacts();
      expect(existsSync(ARTIFACTS_ROOT)).toBe(false);
    });

    it("does not throw when directory does not exist", () => {
      expect(() => cleanupArtifacts()).not.toThrow();
    });
  });
});
