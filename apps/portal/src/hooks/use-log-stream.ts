// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useRef, useState, useCallback } from "react";
import { api, apiFetch } from "@/lib/api";
import type { LogEvent } from "@/types";

interface UseLogStreamOptions {
  /** Run ID to stream logs for */
  id: string;
  /** Whether the stream is enabled (default: true) */
  enabled?: boolean;
  /** Start from the beginning (default: true) */
  fromStart?: boolean;
  /** Attempt number — used to detect when a new attempt is created and reconnect (default: undefined) */
  attemptNumber?: number;
  /** Custom URL builder (default: api.logsUrl). Use api.reportLogsUrl for reports. */
  urlBuilder?: (id: string, fromStart: boolean) => string;
}

interface UseLogStreamReturn {
  logs: LogEvent[];
  isConnected: boolean;
  isDone: boolean;
  error: string | null;
  clear: () => void;
}

export function useLogStream({
  id,
  enabled = true,
  fromStart = true,
  attemptNumber,
  urlBuilder = api.logsUrl,
}: UseLogStreamOptions): UseLogStreamReturn {
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clear = useCallback(() => setLogs([]), []);

  useEffect(() => {
    if (!enabled || !id) return;

    abortRef.current?.abort();

    // Reset state for fresh connection
    setLogs([]);
    setIsDone(false);
    setError(null);

    const url = urlBuilder(id, fromStart);
    const abortController = new AbortController();
    abortRef.current = abortController;

    void streamLogs(url, abortController.signal, {
      onOpen: () => {
        setIsConnected(true);
        setError(null);
      },
      onLog: (log) => setLogs((prev) => [...prev, log]),
      onDone: () => {
        setIsDone(true);
        setIsConnected(false);
      },
      onTimeout: () => {
        setError("Stream timed out");
        setIsConnected(false);
      },
      onError: (message) => {
        setError(message);
        setIsConnected(false);
      },
    });

    return () => {
      abortController.abort();
      abortRef.current = null;
      setIsConnected(false);
    };
  }, [id, enabled, fromStart, attemptNumber, urlBuilder]);

  return { logs, isConnected, isDone, error, clear };
}

interface StreamCallbacks {
  onOpen: () => void;
  onLog: (log: LogEvent) => void;
  onDone: () => void;
  onTimeout: () => void;
  onError: (message: string) => void;
}

async function streamLogs(url: string, signal: AbortSignal, callbacks: StreamCallbacks): Promise<void> {
  try {
    const response = await apiFetch(url, {
      headers: { Accept: "text/event-stream" },
      signal,
    });

    if (!response.ok || !response.body) {
      callbacks.onError(response.statusText || `HTTP ${response.status}`);
      return;
    }

    callbacks.onOpen();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const eventBlock of events) {
        handleSseEvent(eventBlock, callbacks);
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    callbacks.onError(error instanceof Error ? error.message : "Connection lost");
  }
}

function handleSseEvent(eventBlock: string, callbacks: StreamCallbacks): void {
  const lines = eventBlock.split("\n");
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (eventName === "done") {
    callbacks.onDone();
    return;
  }
  if (eventName === "timeout") {
    callbacks.onTimeout();
    return;
  }

  const data = dataLines.join("\n");
  if (!data) return;

  if (eventName === "error") {
    callbacks.onError(parseErrorMessage(data));
    return;
  }

  const log = parseLogEvent(data);
  if (log) callbacks.onLog(log);
}

function parseLogEvent(data: string): LogEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isLogEvent(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseErrorMessage(data: string): string {
  try {
    const parsed: unknown = JSON.parse(data);
    if (isRecord(parsed) && typeof parsed.message === "string") return parsed.message;
  } catch {
    // Fall through to default below.
  }
  return "Cannot connect to log storage";
}

function isLogEvent(value: unknown): value is LogEvent {
  return (
    isRecord(value) &&
    typeof value.timestamp === "string" &&
    typeof value.message === "string" &&
    typeof value.level === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
