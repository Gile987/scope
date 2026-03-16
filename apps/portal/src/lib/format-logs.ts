// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LogEvent } from "../types.js";

export function formatLogsAsText(logs: LogEvent[]): string {
  return logs
    .map((log) => {
      const time = new Date(log.timestamp).toISOString();
      const level = log.level.toUpperCase().padEnd(5);
      const source = log.source ? ` [${log.source}]` : "";
      const extras = log.data
        ? Object.entries(log.data)
            .filter(([k]) => k !== "iteration" && k !== "final")
            .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
            .join(" ")
        : "";
      return `${time} ${level}${source} ${log.message}${extras ? ` ${extras}` : ""}`;
    })
    .join("\n");
}
