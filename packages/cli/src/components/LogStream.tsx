// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, useStdout, measureElement, DOMElement } from "ink";
import type { LogEntry } from "../hooks/useSSELogs.js";

interface LogStreamProps {
  logs: LogEntry[];
  filter: string | null;
  autoScroll?: boolean;
  maxHeight?: number;
}

const WORKER_COLORS: Record<string, string> = {
  "coder-acp-claude-code": "cyan",
  "coder-acp-copilot": "magenta",
  "coder-vscode-web": "blue",
};

const LEVEL_COLORS: Record<string, string> = {
  info: "white",
  warn: "yellow",
  error: "red",
  debug: "gray",
};

function getWorkerTag(worker: string, requestNum: number): string {
  let name: string;
  if (worker.includes("claude")) name = "claude";
  else if (worker.includes("copilot")) name = "copilot";
  else if (worker.includes("vscode")) name = "vscode";
  else name = worker;
  return `${name}#${requestNum}`;
}

function LogLine({ log }: { log: LogEntry }): React.ReactElement {
  const workerColor = WORKER_COLORS[log.worker] || "white";
  const levelColor = LEVEL_COLORS[log.level] || "white";
  const timestamp = new Date(log.timestamp).toLocaleTimeString();
  const tag = getWorkerTag(log.worker, log.requestNum);

  return (
    <Box>
      <Text dimColor>[{timestamp}]</Text>
      <Text> </Text>
      <Text color={workerColor} bold>[{tag}]</Text>
      <Text> </Text>
      <Text color={levelColor}>{log.message}</Text>
    </Box>
  );
}

export function LogStream({ logs, filter, autoScroll = true, maxHeight }: LogStreamProps): React.ReactElement {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [terminalSize, setTerminalSize] = useState({ rows: 24, columns: 80 });
  const [contentHeight, setContentHeight] = useState(0);
  const [manualScroll, setManualScroll] = useState(false);
  const { stdout } = useStdout();
  const contentRef = useRef<DOMElement>(null);

  // Filter logs
  const filteredLogs = filter
    ? logs.filter((log) => log.worker === filter)
    : logs;

  // Update terminal size on resize
  useEffect(() => {
    if (!stdout) return;
    const updateSize = () =>
      setTerminalSize({
        rows: stdout.rows ?? 24,
        columns: stdout.columns ?? 80,
      });
    updateSize();
    stdout.on("resize", updateSize);
    return () => {
      stdout.off("resize", updateSize);
    };
  }, [stdout]);

  // Measure content height after render
  useEffect(() => {
    if (contentRef.current) {
      const { height } = measureElement(contentRef.current);
      setContentHeight(height);
    }
  });

  // Use maxHeight if provided, otherwise calculate from terminal size
  // Reserve space for header (~8 lines: title + progress) and footer (~4 lines: scroll hint + filter bar + completion message)
  const viewportHeight = maxHeight ?? Math.max(5, terminalSize.rows - 14);
  const maxScroll = Math.max(0, contentHeight - viewportHeight);

  // Auto-scroll to bottom when new logs arrive (unless user scrolled up)
  useEffect(() => {
    if (autoScroll && !manualScroll) {
      setScrollOffset(maxScroll);
    }
  }, [filteredLogs.length, maxScroll, autoScroll, manualScroll]);

  // Reset manual scroll flag when at bottom
  useEffect(() => {
    if (scrollOffset >= maxScroll - 1) {
      setManualScroll(false);
    }
  }, [scrollOffset, maxScroll]);

  // Keyboard navigation
  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setManualScroll(true);
      setScrollOffset((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === "j") {
      setScrollOffset((prev) => Math.min(maxScroll, prev + 1));
    } else if (key.pageUp) {
      setManualScroll(true);
      setScrollOffset((prev) => Math.max(0, prev - viewportHeight));
    } else if (key.pageDown || input === " ") {
      setScrollOffset((prev) => Math.min(maxScroll, prev + viewportHeight));
    } else if (input === "g") {
      setManualScroll(true);
      setScrollOffset(0);
    } else if (input === "G") {
      setManualScroll(false);
      setScrollOffset(maxScroll);
    }
  });

  const scrollPercent =
    maxScroll <= 0 ? 100 : Math.round((scrollOffset / maxScroll) * 100);

  return (
    <Box flexDirection="column" height={viewportHeight + 2}>
      <Box
        height={viewportHeight}
        overflowY="hidden"
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
      >
        <Box
          ref={contentRef}
          marginTop={-scrollOffset}
          flexShrink={0}
          flexDirection="column"
          paddingX={1}
        >
          {filteredLogs.length === 0 ? (
            <Text dimColor>Waiting for logs...</Text>
          ) : (
            filteredLogs.map((log, index) => (
              <LogLine key={`${log.requestId}-${index}`} log={log} />
            ))
          )}
        </Box>
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>
          ↑↓/jk: scroll | PgUp/PgDn: page | g/G: top/bottom
        </Text>
        <Text dimColor>
          {manualScroll ? "📌 " : ""}
          {scrollPercent}% | {filteredLogs.length} logs
        </Text>
      </Box>
    </Box>
  );
}
