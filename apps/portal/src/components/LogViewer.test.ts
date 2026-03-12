// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { formatLogsAsText } from "../lib/format-logs.js";
import type { LogEvent } from "../types.js";

describe("formatLogsAsText", () => {
  it("returns empty string for no logs", () => {
    expect(formatLogsAsText([])).toBe("");
  });

  it("formats a basic log event", () => {
    const logs: LogEvent[] = [
      {
        timestamp: "2026-03-12T10:00:00.000Z",
        level: "info",
        message: "Worker started",
      },
    ];
    expect(formatLogsAsText(logs)).toBe(
      "2026-03-12T10:00:00.000Z INFO  Worker started"
    );
  });

  it("includes source when present", () => {
    const logs: LogEvent[] = [
      {
        timestamp: "2026-03-12T10:00:00.000Z",
        level: "error",
        source: "copilot",
        message: "Connection lost",
      },
    ];
    expect(formatLogsAsText(logs)).toBe(
      "2026-03-12T10:00:00.000Z ERROR [copilot] Connection lost"
    );
  });

  it("includes extra data fields, excluding iteration and final", () => {
    const logs: LogEvent[] = [
      {
        timestamp: "2026-03-12T10:00:00.000Z",
        level: "debug",
        message: "Step complete",
        data: { iteration: 3, final: true, exitCode: 0, tool: "git" },
      },
    ];
    expect(formatLogsAsText(logs)).toBe(
      "2026-03-12T10:00:00.000Z DEBUG Step complete exitCode=0 tool=git"
    );
  });

  it("formats multiple log events separated by newlines", () => {
    const logs: LogEvent[] = [
      {
        timestamp: "2026-03-12T10:00:00.000Z",
        level: "info",
        message: "Started",
      },
      {
        timestamp: "2026-03-12T10:00:01.000Z",
        level: "warn",
        message: "Slow response",
      },
    ];
    const result = formatLogsAsText(logs);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("INFO");
    expect(lines[1]).toContain("WARN");
  });
});
