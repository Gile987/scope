// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useStdout } from "ink";
import EventSource from "eventsource";
import { ProgressHeader } from "./ProgressHeader.js";
import { LogStream } from "./LogStream.js";
import { FilterBar } from "./FilterBar.js";
import type { RequestInfo } from "../hooks/useRequestSubmit.js";
import type { LogEntry } from "../hooks/useSSELogs.js";

interface DemoAppProps {
  apiUrl: string;
  message: string;
  count: number;
  workers: string[];
}

export function DemoApp({ apiUrl, message, count, workers }: DemoAppProps): React.ReactElement {
  const [requests, setRequests] = useState<RequestInfo[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<string | null>(null);
  const [phase, setPhase] = useState<"submitting" | "streaming" | "done">("submitting");
  const [eventSources, setEventSources] = useState<EventSource[]>([]);
  const [terminalRows, setTerminalRows] = useState(24);
  const { stdout } = useStdout();

  // Track terminal size
  useEffect(() => {
    if (!stdout) return;
    const updateRows = () => setTerminalRows(stdout.rows ?? 24);
    updateRows();
    stdout.on("resize", updateRows);
    return () => { stdout.off("resize", updateRows); };
  }, [stdout]);

  // Append a log entry
  const appendLog = useCallback((log: LogEntry) => {
    setLogs((prev) => [...prev, log]);
  }, []);

  // Update request status
  const updateRequestStatus = useCallback(
    (requestId: string, status: RequestInfo["status"]) => {
      setRequests((prev) =>
        prev.map((r) => (r.id === requestId ? { ...r, status } : r))
      );
    },
    []
  );

  // Submit all requests on mount
  useEffect(() => {
    const submitRequests = async () => {
      // Create placeholder requests with request numbers
      const pendingRequests: (RequestInfo & { requestNum: number })[] = [];
      for (const worker of workers) {
        for (let i = 0; i < count; i++) {
          pendingRequests.push({
            id: `pending-${worker}-${i}`,
            worker,
            status: "pending",
            requestNum: i + 1, // 1-based request number per worker
          });
        }
      }
      setRequests(pendingRequests);

      // Submit all concurrently
      const submissions = pendingRequests.map(async (req, index) => {
        try {
          const response = await fetch(
            `${apiUrl}/api/v1/requests?worker=${req.worker}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message }),
            }
          );

          if (!response.ok) {
            const error = await response.json();
            setRequests((prev) =>
              prev.map((r, i) =>
                i === index
                  ? { ...r, status: "failed" as const, error: error.message }
                  : r
              )
            );
            return null;
          }

          const result = await response.json();
          setRequests((prev) =>
            prev.map((r, i) =>
              i === index
                ? { ...r, id: result.id, status: "submitted" as const }
                : r
            )
          );
          return { id: result.id, worker: req.worker, requestNum: req.requestNum };
        } catch (err) {
          setRequests((prev) =>
            prev.map((r, i) =>
              i === index
                ? {
                    ...r,
                    status: "failed" as const,
                    error: err instanceof Error ? err.message : "Unknown error",
                  }
                : r
            )
          );
          return null;
        }
      });

      const results = await Promise.all(submissions);
      const successfulRequests = results.filter(
        (r): r is { id: string; worker: string; requestNum: number } => r !== null
      );

      setPhase("streaming");

      // Start SSE connections for each successful request
      const sources: EventSource[] = [];
      for (const req of successfulRequests) {
        const url = `${apiUrl}/api/v1/requests/${req.id}/logs?fromStart=true`;
        const eventSource = new EventSource(url);

        eventSource.onmessage = (event) => {
          try {
            const log = JSON.parse(event.data);
            appendLog({
              ...log,
              requestId: req.id,
              worker: req.worker,
              requestNum: req.requestNum,
            });
          } catch {
            // Ignore parse errors
          }
        };

        eventSource.addEventListener("done", () => {
          updateRequestStatus(req.id, "completed");
          eventSource.close();
        });

        eventSource.addEventListener("error", () => {
          updateRequestStatus(req.id, "failed");
          eventSource.close();
        });

        eventSource.addEventListener("timeout", () => {
          updateRequestStatus(req.id, "completed");
          eventSource.close();
        });

        sources.push(eventSource);
      }
      setEventSources(sources);
    };

    submitRequests();
  }, [apiUrl, message, count, workers, appendLog, updateRequestStatus]);

  // Check if all requests are done
  useEffect(() => {
    if (phase === "streaming") {
      const allDone = requests.every(
        (r) => r.status === "completed" || r.status === "failed"
      );
      if (allDone && requests.length > 0 && !requests.some((r) => r.id.startsWith("pending"))) {
        setPhase("done");
      }
    }
  }, [requests, phase]);

  // Cleanup event sources on unmount
  useEffect(() => {
    return () => {
      eventSources.forEach((es) => es.close());
    };
  }, [eventSources]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          🚀 Demo: Concurrent Coder Requests
        </Text>
        <Text dimColor>
          {" "}| {count}× each coder | "{message.slice(0, 40)}
          {message.length > 40 ? "..." : ""}"
        </Text>
      </Box>

      <ProgressHeader requests={requests} workers={workers} />

      {phase === "submitting" && (
        <Box>
          <Text color="yellow">⏳ Submitting requests...</Text>
        </Box>
      )}

      {(phase === "streaming" || phase === "done") && (
        <>
          <LogStream 
            logs={logs} 
            filter={filter} 
            maxHeight={Math.max(5, terminalRows - 16)}
          />
          <FilterBar
            filter={filter}
            onFilterChange={setFilter}
            workers={workers}
          />
        </>
      )}

      {phase === "done" && (
        <Box marginTop={1}>
          <Text color="green" bold>
            ✅ All requests completed
          </Text>
        </Box>
      )}
    </Box>
  );
}
