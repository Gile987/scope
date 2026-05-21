// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "@/lib/api";
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
  const eventSourceRef = useRef<EventSource | null>(null);

  const clear = useCallback(() => setLogs([]), []);

  useEffect(() => {
    if (!enabled || !id) return;

    // Close any existing connection when dependencies change (especially attemptNumber)
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    // Reset state for fresh connection
    setLogs([]);
    setIsDone(false);
    setError(null);

    const url = urlBuilder(id, fromStart);
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        // The SSE stream multiplexes log events with summary payloads
        // (e.g. { type: "turns_summary", ... }). Only treat well-formed
        // log events with a timestamp as logs — otherwise the LogViewer
        // would render "Invalid Date" for the summary row.
        if (!parsed || typeof parsed.timestamp !== "string" || typeof parsed.message !== "string") {
          return;
        }
        setLogs((prev) => [...prev, parsed as LogEvent]);
      } catch {
        // Non-JSON messages (heartbeats, etc.)
      }
    };

    es.addEventListener("done", () => {
      setIsDone(true);
      setIsConnected(false);
      es.close();
    });

    es.addEventListener("timeout", () => {
      setError("Stream timed out");
      setIsConnected(false);
      es.close();
    });

    es.addEventListener("error", (event: MessageEvent) => {
      try {
        const { message } = JSON.parse(event.data) as { message: string };
        setError(message);
      } catch {
        setError("Cannot connect to log storage");
      }
      setIsConnected(false);
      es.close();
    });

    es.onerror = () => {
      setIsConnected(false);
      // EventSource auto-reconnects; only set error if CLOSED.
      // Use functional update to avoid overwriting a more specific error
      // already set by the named "error" event listener.
      if (es.readyState === EventSource.CLOSED) {
        setError((prev) => prev ?? "Connection lost");
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setIsConnected(false);
    };
  }, [id, enabled, fromStart, attemptNumber, urlBuilder]);

  return { logs, isConnected, isDone, error, clear };
}
