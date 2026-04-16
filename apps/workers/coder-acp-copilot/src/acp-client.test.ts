// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import { runACPSession } from "./acp-client.js";
import path from "node:path";
import os from "node:os";

describe("runACPSession", () => {
  const cwd = os.tmpdir();
  const noop = () => {};

  describe("subprocess early exit", () => {
    it("rejects when the agent process exits immediately with non-zero code", async () => {
      // Use a command that exits immediately with code 1
      await expect(
        runACPSession("hello", {
          command: "node",
          args: ["-e", "process.exit(1)"],
          cwd,
          onLog: noop,
          sessionTimeoutMs: 5000,
        })
      ).rejects.toThrow(/ACP agent process exited unexpectedly \(code 1\)/);
    });

    it("rejects when the agent process prints to stderr and exits", async () => {
      await expect(
        runACPSession("hello", {
          command: "node",
          args: ["-e", 'console.error("Node.js v24 required"); process.exit(1)'],
          cwd,
          onLog: noop,
          sessionTimeoutMs: 5000,
        })
      ).rejects.toThrow(/ACP agent process exited unexpectedly/);
    });

    it("rejects when the command is not found", async () => {
      await expect(
        runACPSession("hello", {
          command: "nonexistent-binary-that-does-not-exist",
          args: [],
          cwd,
          onLog: noop,
          sessionTimeoutMs: 5000,
        })
      ).rejects.toThrow(/ACP agent process failed to start/);
    });
  });

  describe("session timeout", () => {
    it("rejects after the configured timeout", async () => {
      // Use a command that hangs (cat with no input on stdin will block)
      await expect(
        runACPSession("hello", {
          command: "node",
          args: ["-e", "setTimeout(() => {}, 60000)"],
          cwd,
          onLog: noop,
          sessionTimeoutMs: 200,
        })
      ).rejects.toThrow(/ACP session timed out after 200ms/);
    });
  });
});
