// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useEffect, useCallback } from "react";
import EventSource from "eventsource";

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  data?: Record<string, unknown>;
  requestId: string;
  worker: string;
  requestNum: number;
}

export interface SSELogsState {
  logs: LogEntry[];
  status: "connecting" | "connected" | "done" | "error";
  error?: string;
}

export function useSSELogs(
  requestId: string,
  worker: string,
  apiUrl: string,
  onStatusChange?: (requestId: string, status: "done" | "error") => void
): SSELogsState {
  const [state, setState] = useState<SSELogsState>({
    logs: [],
    status: "connecting",
  });

  const appendLog = useCallback((log: LogEntry) => {
    setState((prev) => ({
      ...prev,
      logs: [...prev.logs, log],
    }));
  }, []);

  useEffect(() => {
    const url = `${apiUrl}/api/v1/requests/${requestId}/logs?fromStart=true`;
    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      setState((prev) => ({ ...prev, status: "connected" }));
    };

    eventSource.onmessage = (event) => {
      try {
        const log = JSON.parse(event.data);
        appendLog({
          ...log,
          requestId,
          worker,
        });
      } catch {
        // Ignore parse errors
      }
    };

    eventSource.addEventListener("done", (event) => {
      setState((prev) => ({ ...prev, status: "done" }));
      eventSource.close();
      onStatusChange?.(requestId, "done");
    });

    eventSource.addEventListener("error", () => {
      setState((prev) => ({ ...prev, status: "error", error: "Connection error" }));
      eventSource.close();
      onStatusChange?.(requestId, "error");
    });

    eventSource.addEventListener("timeout", () => {
      setState((prev) => ({ ...prev, status: "done" }));
      eventSource.close();
      onStatusChange?.(requestId, "done");
    });

    return () => {
      eventSource.close();
    };
  }, [requestId, worker, apiUrl, appendLog, onStatusChange]);

  return state;
}
