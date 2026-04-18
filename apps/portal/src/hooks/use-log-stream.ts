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

    const url = urlBuilder(id, fromStart);
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    es.onmessage = (event) => {
      try {
        const logEvent = JSON.parse(event.data) as LogEvent;
        setLogs((prev) => [...prev, logEvent]);
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
  }, [id, enabled, fromStart, urlBuilder]);

  return { logs, isConnected, isDone, error, clear };
}
