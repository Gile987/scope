// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLogStream } from "@/hooks/use-log-stream";
import { formatLogsAsText } from "@/lib/format-logs";
import type { LogEvent } from "@/types";
import { Check, Circle, Copy, Wifi, WifiOff } from "lucide-react";

const levelColors: Record<string, string> = {
  info: "text-blue-600 dark:text-blue-400",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
  debug: "text-gray-500 dark:text-gray-400",
};

interface LogViewerProps {
  runId: string;
  enabled?: boolean;
  /** If provided, LogViewer uses these instead of creating its own stream */
  logs?: LogEvent[];
  isConnected?: boolean;
  isDone?: boolean;
  error?: string | null;
}

export function LogViewer({
  runId,
  enabled = true,
  logs: externalLogs,
  isConnected: externalIsConnected,
  isDone: externalIsDone,
  error: externalError,
}: LogViewerProps) {
  // Use external data if provided, otherwise fall back to own hook
  const ownStream = useLogStream({
    id: runId,
    enabled: enabled && externalLogs === undefined,
    fromStart: true,
  });

  const logs = externalLogs ?? ownStream.logs;
  const isConnected = externalIsConnected ?? ownStream.isConnected;
  const isDone = externalIsDone ?? ownStream.isDone;
  const error = externalError !== undefined ? externalError : ownStream.error;
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (logs.length === 0) return;
    await navigator.clipboard.writeText(formatLogsAsText(logs));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [logs]);

  // Auto-scroll to bottom on new logs
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  return (
    <div className="flex flex-col gap-2">
      {/* Connection status */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {isConnected ? (
          <>
            <Wifi className="h-3 w-3 text-emerald-500" />
            <span>Connected — streaming live</span>
          </>
        ) : isDone ? (
          <>
            <Circle className="h-3 w-3 text-muted-foreground" />
            <span>Stream complete ({logs.length} events)</span>
          </>
        ) : error ? (
          <>
            <WifiOff className="h-3 w-3 text-red-500" />
            <span>{error}</span>
          </>
        ) : (
          <>
            <Circle className="h-3 w-3 animate-pulse" />
            <span>Connecting…</span>
          </>
        )}
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs text-muted-foreground"
            disabled={logs.length === 0}
            onClick={handleCopy}
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                Copy logs
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Log area */}
      <ScrollArea className="h-[500px] rounded-md border bg-slate-950 p-4">
        <div className="font-mono text-xs leading-relaxed">
          {logs.length === 0 && (
            <div className="text-slate-500 italic">No log events yet…</div>
          )}
          {logs.map((log, i) => {
            const iteration = log.data?.iteration as number | undefined;
            const prevIteration = i > 0 ? (logs[i - 1].data?.iteration as number | undefined) : undefined;
            const showIterationDivider = iteration !== undefined && iteration !== prevIteration;
            const showSetupDivider = log.data?.phase === "setup";
            const isIterationHeader = !!log.data?.iterationHeader;

            return (
              <div key={i}>
                {showSetupDivider && (
                  <div className="flex items-center gap-2 py-1.5 my-1 select-none">
                    <div className="flex-1 border-t border-slate-700" />
                    <span className="text-emerald-500 text-[10px] font-semibold tracking-wider uppercase">
                      Setup
                    </span>
                    <div className="flex-1 border-t border-slate-700" />
                  </div>
                )}
                {showIterationDivider && (
                  <div className="flex items-center gap-2 py-1.5 my-1 select-none">
                    <div className="flex-1 border-t border-slate-700" />
                    <span className="text-cyan-500 text-[10px] font-semibold tracking-wider uppercase">
                      Iteration {iteration}
                    </span>
                    <div className="flex-1 border-t border-slate-700" />
                  </div>
                )}
                {!isIterationHeader && (
                <div className="flex gap-2 py-0.5 hover:bg-slate-900/50">
                  <span className="text-slate-500 shrink-0 select-none">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span
                    className={cn(
                      "uppercase w-12 shrink-0 font-semibold select-none",
                      levelColors[log.level] || "text-slate-400"
                    )}
                  >
                    {log.level}
                  </span>
                  {iteration !== undefined && (
                    <span className="text-cyan-400 shrink-0 select-none">iter {iteration}</span>
                  )}
                  {log.source && (
                    <span className="text-purple-400 shrink-0">[{log.source}]</span>
                  )}
                  <span className="text-slate-200 break-all">{log.message}</span>
                  {log.data && Object.keys(log.data).filter(k => k !== "iteration" && k !== "final" && k !== "phase" && k !== "iterationHeader").length > 0 && (
                    <span className="text-slate-500 shrink-0 truncate max-w-[40%]" title={JSON.stringify(log.data, null, 2)}>
                      {Object.entries(log.data)
                        .filter(([k]) => k !== "iteration" && k !== "final" && k !== "phase" && k !== "iterationHeader")
                        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
                        .join(" ")}
                    </span>
                  )}
                </div>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
