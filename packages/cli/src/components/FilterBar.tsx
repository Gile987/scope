// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import React from "react";
import { Box, Text, useInput, useApp } from "ink";

interface FilterBarProps {
  filter: string | null;
  onFilterChange: (filter: string | null) => void;
  workers: string[];
}

const WORKER_COLORS: Record<string, string> = {
  "coder-acp-claude-code": "cyan",
  "coder-acp-copilot": "magenta",
  "coder-vscode-web": "blue",
};

function getWorkerShortName(worker: string): string {
  if (worker.includes("claude")) return "claude";
  if (worker.includes("copilot")) return "copilot";
  if (worker.includes("vscode")) return "vscode";
  return worker;
}

export function FilterBar({ filter, onFilterChange, workers }: FilterBarProps): React.ReactElement {
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    } else if (input === "0" || input === "a") {
      onFilterChange(null);
    } else if (input === "1" && workers[0]) {
      onFilterChange(filter === workers[0] ? null : workers[0]);
    } else if (input === "2" && workers[1]) {
      onFilterChange(filter === workers[1] ? null : workers[1]);
    } else if (input === "3" && workers[2]) {
      onFilterChange(filter === workers[2] ? null : workers[2]);
    }
  });

  return (
    <Box borderStyle="single" paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        <Text bold>Filter:</Text>
        <Text
          color={filter === null ? "green" : undefined}
          bold={filter === null}
          inverse={filter === null}
        >
          {" "}[a]ll{" "}
        </Text>
        {workers.map((worker, index) => {
          const isActive = filter === worker;
          const color = WORKER_COLORS[worker] || "white";
          const shortName = getWorkerShortName(worker);
          return (
            <Text
              key={worker}
              color={isActive ? color : undefined}
              bold={isActive}
              inverse={isActive}
            >
              {" "}[{index + 1}]{shortName}{" "}
            </Text>
          );
        })}
      </Box>
      <Text dimColor>Press 'q' to quit</Text>
    </Box>
  );
}
