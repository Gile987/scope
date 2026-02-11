// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useLogStream } from "@/hooks/use-log-stream";
import { Circle, Wifi, WifiOff } from "lucide-react";

const levelColors: Record<string, string> = {
  info: "text-blue-600 dark:text-blue-400",
  warn: "text-amber-600 dark:text-amber-400",
  error: "text-red-600 dark:text-red-400",
  debug: "text-gray-500 dark:text-gray-400",
};

interface LogViewerProps {
  runId: string;
  enabled?: boolean;
}

export function LogViewer({ runId, enabled = true }: LogViewerProps) {
  const { logs, isConnected, isDone, error } = useLogStream({
    id: runId,
    enabled,
    fromStart: true,
  });
  const bottomRef = useRef<HTMLDivElement>(null);

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
      </div>

      {/* Log area */}
      <ScrollArea className="h-[500px] rounded-md border bg-slate-950 p-4">
        <div className="font-mono text-xs leading-relaxed">
          {logs.length === 0 && (
            <div className="text-slate-500 italic">No log events yet…</div>
          )}
          {logs.map((log, i) => (
            <div key={i} className="flex gap-2 py-0.5 hover:bg-slate-900/50">
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
              {log.source && (
                <span className="text-purple-400 shrink-0">[{log.source}]</span>
              )}
              <span className="text-slate-200 break-all">{log.message}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  );
}
