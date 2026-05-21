// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ACPClientHandler } from "./acp-client.js";

describe("ACPClientHandler", () => {
  let workspace: string;
  let logs: string[];
  let handler: ACPClientHandler;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "acp-test-"));
    logs = [];
    handler = new ACPClientHandler((msg) => logs.push(msg), workspace);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  describe("writeTextFile", () => {
    it("writes content to a relative path", async () => {
      await handler.writeTextFile({
        path: "app.py",
        content: "print('hello')",
        sessionId: "test-session",
      });

      const written = readFileSync(join(workspace, "app.py"), "utf-8");
      expect(written).toBe("print('hello')");
    });

    it("creates nested parent directories", async () => {
      await handler.writeTextFile({
        path: "src/lib/utils.ts",
        content: "export const x = 1;",
        sessionId: "test-session",
      });

      const written = readFileSync(join(workspace, "src/lib/utils.ts"), "utf-8");
      expect(written).toBe("export const x = 1;");
    });

    it("overwrites existing files", async () => {
      const filePath = join(workspace, "file.txt");
      writeFileSync(filePath, "old content");

      await handler.writeTextFile({
        path: "file.txt",
        content: "new content",
        sessionId: "test-session",
      });

      expect(readFileSync(filePath, "utf-8")).toBe("new content");
    });

    it("writes absolute paths within workspace", async () => {
      const absPath = join(workspace, "abs-file.txt");

      await handler.writeTextFile({
        path: absPath,
        content: "absolute write",
        sessionId: "test-session",
      });

      expect(readFileSync(absPath, "utf-8")).toBe("absolute write");
    });

    it("logs the write with character count", async () => {
      await handler.writeTextFile({
        path: "readme.md",
        content: "# Hello",
        sessionId: "test-session",
      });

      expect(logs).toContainEqual("Write file: readme.md (7 chars)");
    });

    it("handles empty content", async () => {
      await handler.writeTextFile({
        path: "empty.txt",
        content: "",
        sessionId: "test-session",
      });

      expect(readFileSync(join(workspace, "empty.txt"), "utf-8")).toBe("");
      expect(logs).toContainEqual("Write file: empty.txt (0 chars)");
    });
  });

  describe("readTextFile", () => {
    it("reads existing file content", async () => {
      writeFileSync(join(workspace, "data.txt"), "file content");

      const result = await handler.readTextFile({
        path: "data.txt",
        sessionId: "test-session",
      });

      expect(result.content).toBe("file content");
    });

    it("returns empty string for non-existent file", async () => {
      const result = await handler.readTextFile({
        path: "missing.txt",
        sessionId: "test-session",
      });

      expect(result.content).toBe("");
    });

    it("reads from nested paths", async () => {
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src/index.ts"), "export {}");

      const result = await handler.readTextFile({
        path: "src/index.ts",
        sessionId: "test-session",
      });

      expect(result.content).toBe("export {}");
    });

    it("reads file written by writeTextFile", async () => {
      await handler.writeTextFile({
        path: "round-trip.txt",
        content: "round trip content",
        sessionId: "test-session",
      });

      const result = await handler.readTextFile({
        path: "round-trip.txt",
        sessionId: "test-session",
      });

      expect(result.content).toBe("round trip content");
    });

    it("logs the read", async () => {
      writeFileSync(join(workspace, "log-test.txt"), "x");

      await handler.readTextFile({
        path: "log-test.txt",
        sessionId: "test-session",
      });

      expect(logs).toContainEqual("Read file: log-test.txt");
    });
  });

  describe("path traversal protection", () => {
    it("blocks absolute paths outside workspace", async () => {
      await expect(
        handler.writeTextFile({
          path: "/etc/passwd",
          content: "malicious",
          sessionId: "test-session",
        })
      ).rejects.toThrow("Path traversal blocked");
    });

    it("blocks relative paths that escape workspace", async () => {
      await expect(
        handler.writeTextFile({
          path: "../../etc/shadow",
          content: "malicious",
          sessionId: "test-session",
        })
      ).rejects.toThrow("Path traversal blocked");
    });

    it("blocks traversal on readTextFile too", async () => {
      await expect(
        handler.readTextFile({
          path: "../../../etc/hostname",
          sessionId: "test-session",
        })
      ).rejects.toThrow("Path traversal blocked");
    });

    it("allows paths that contain .. but stay within workspace", async () => {
      mkdirSync(join(workspace, "a/b"), { recursive: true });

      await handler.writeTextFile({
        path: "a/b/../c.txt",
        content: "ok",
        sessionId: "test-session",
      });

      expect(readFileSync(join(workspace, "a/c.txt"), "utf-8")).toBe("ok");
    });
  });
});
