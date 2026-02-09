// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import React from "react";
import { Box, Text } from "ink";
import type { RequestInfo } from "../hooks/useRequestSubmit.js";

interface ProgressHeaderProps {
  requests: RequestInfo[];
  workers: string[];
}

const WORKER_COLORS: Record<string, string> = {
  "coder-acp-claude-code": "cyan",
  "coder-acp-copilot": "magenta",
  "coder-vscode-web": "blue",
};

function getWorkerColor(worker: string): string {
  return WORKER_COLORS[worker] || "white";
}

function getWorkerShortName(worker: string): string {
  if (worker.includes("claude")) return "claude";
  if (worker.includes("copilot")) return "copilot";
  if (worker.includes("vscode")) return "vscode";
  return worker;
}

function ProgressBar({ completed, total, width = 20 }: { completed: number; total: number; width?: number }): React.ReactElement {
  const filled = Math.round((completed / total) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return (
    <Text>
      [<Text color="green">{bar.slice(0, filled)}</Text>
      <Text dimColor>{bar.slice(filled)}</Text>] {completed}/{total}
    </Text>
  );
}

export function ProgressHeader({ requests, workers }: ProgressHeaderProps): React.ReactElement {
  const totalRequests = requests.length;
  const completedRequests = requests.filter(
    (r) => r.status === "completed" || r.status === "failed"
  ).length;
  const runningRequests = requests.filter(
    (r) => r.status === "submitted" || r.status === "processing"
  ).length;

  // Per-worker breakdown
  const workerStats = workers.map((worker) => {
    const workerRequests = requests.filter((r) => r.worker === worker);
    const completed = workerRequests.filter((r) => r.status === "completed").length;
    const failed = workerRequests.filter((r) => r.status === "failed").length;
    const running = workerRequests.filter(
      (r) => r.status === "submitted" || r.status === "processing"
    ).length;
    const total = workerRequests.length;
    return { worker, completed, failed, running, total };
  });

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold>Demo Progress </Text>
        <ProgressBar completed={completedRequests} total={totalRequests} />
        {runningRequests > 0 && (
          <Text color="yellow"> ({runningRequests} running)</Text>
        )}
      </Box>
      <Box gap={2}>
        {workerStats.map((stat) => (
          <Box key={stat.worker}>
            <Text color={getWorkerColor(stat.worker)} bold>
              {getWorkerShortName(stat.worker)}:
            </Text>
            <Text> </Text>
            {stat.completed > 0 && <Text color="green">{stat.completed}✓ </Text>}
            {stat.running > 0 && <Text color="yellow">{stat.running}⟳ </Text>}
            {stat.failed > 0 && <Text color="red">{stat.failed}✗ </Text>}
            <Text dimColor>/{stat.total}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
