// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Bot, Scale, CheckCircle2, AlertCircle, Brain, Wrench, ChevronRight, ChevronDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { ConversationTurn, ToolCall } from "@/types";

interface ConversationViewProps {
  turns: ConversationTurn[];
  /** The original task / user prompt, shown as the first message */
  task?: string;
}

/**
 * Chat-style conversation view showing agent responses and judge feedback.
 *
 * Layout:
 * - Task prompt (top, full-width, neutral)
 * - For each turn:
 *   - Thinking content (collapsible, muted)
 *   - Agent response (right-aligned, primary tint)
 *   - Tool calls (inline, collapsible)
 *   - Judge feedback (left-aligned, amber tint)
 */
export function ConversationView({ turns, task }: ConversationViewProps) {
  if (turns.length === 0 && !task) {
    return (
      <div className="text-sm text-muted-foreground italic py-4 text-center">
        No conversation data available.
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-4xl mx-auto py-2">
      {/* Task prompt */}
      {task && (
        <div className="flex justify-center">
          <Card className="max-w-[85%] bg-muted/40 border-muted">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="secondary" className="text-xs gap-1">
                  Task
                </Badge>
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{task}</ReactMarkdown>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Turn messages */}
      {turns.map((turn) => (
        <TurnMessages key={turn.iteration} turn={turn} />
      ))}
    </div>
  );
}

/** Collapsible section with a toggle header */
function CollapsibleSection({
  label,
  icon: Icon,
  iconClassName,
  count,
  defaultOpen = false,
  children,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-left py-1"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Icon className={cn("h-3 w-3", iconClassName)} />
        <span>{label}</span>
        {count !== undefined && (
          <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{count}</Badge>
        )}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

/** Inline tool call display */
function ToolCallInline({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const hasResponse = !!tc.response;
  const argsStr = JSON.stringify(tc.arguments, null, 2);
  const isLargeArgs = argsStr.length > 80;

  return (
    <div className="rounded border border-border/50 bg-muted/30 text-xs font-mono">
      <button
        type="button"
        className="flex items-center gap-1.5 w-full text-left px-2 py-1.5 hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <Wrench className="h-3 w-3 text-blue-500 shrink-0" />
        <span className="font-semibold text-foreground">{tc.name}</span>
        {!expanded && !isLargeArgs && (
          <span className="text-muted-foreground truncate ml-1">
            {argsStr === "{}" ? "" : argsStr}
          </span>
        )}
        {hasResponse && (
          <Badge variant="outline" className="text-[10px] px-1 py-0 ml-auto shrink-0">
            has response
          </Badge>
        )}
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1.5 border-t border-border/30">
          {argsStr !== "{}" && (
            <div className="mt-1.5">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Arguments</span>
              <pre className="mt-0.5 p-1.5 rounded bg-muted/50 text-[11px] overflow-x-auto whitespace-pre-wrap break-all">{argsStr}</pre>
            </div>
          )}
          {hasResponse && (
            <div>
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Response</span>
              <pre className="mt-0.5 p-1.5 rounded bg-muted/50 text-[11px] overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{tc.response}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TurnMessages({ turn }: { turn: ConversationTurn }) {
  return (
    <>
      {/* Iteration divider */}
      <div className="flex items-center gap-3 my-2">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground font-medium">
          Iteration {turn.iteration}
          {turn.passed && (
            <CheckCircle2 className="inline h-3 w-3 ml-1 text-emerald-600" />
          )}
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Thinking content — collapsible, above agent response */}
      {turn.thinkingContent && (
        <div className="flex justify-end">
          <div className="max-w-[85%] w-full">
            <CollapsibleSection
              label="Thinking"
              icon={Brain}
              iconClassName="text-violet-500"
            >
              <Card className="bg-violet-500/5 border-violet-200 dark:border-violet-800">
                <CardContent className="p-3">
                  <div className="prose prose-sm dark:prose-invert max-w-none max-h-64 overflow-y-auto text-muted-foreground italic text-xs">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{turn.thinkingContent}</ReactMarkdown>
                  </div>
                </CardContent>
              </Card>
            </CollapsibleSection>
          </div>
        </div>
      )}

      {/* Agent response — right aligned */}
      <div className="flex justify-end">
        <Card className={cn(
          "max-w-[85%] border",
          turn.passed
            ? "bg-emerald-500/5 border-emerald-200 dark:border-emerald-800"
            : "bg-primary/5 border-primary/20",
        )}>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Bot className="h-4 w-4 text-primary" />
              <span className="text-xs font-medium text-primary">Coding Agent</span>
              <span className="text-xs text-muted-foreground ml-auto">
                {new Date(turn.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none max-h-96 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{turn.codingAgentResponse}</ReactMarkdown>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tool calls — inline, collapsible */}
      {turn.toolCalls && turn.toolCalls.length > 0 && (
        <div className="flex justify-end">
          <div className="max-w-[85%] w-full">
            <CollapsibleSection
              label="Tool Calls"
              icon={Wrench}
              iconClassName="text-blue-500"
              count={turn.toolCalls.length}
              defaultOpen={turn.toolCalls.length <= 5}
            >
              <div className="space-y-1">
                {turn.toolCalls.map((tc, idx) => (
                  <ToolCallInline key={tc.id || idx} tc={tc} />
                ))}
              </div>
            </CollapsibleSection>
          </div>
        </div>
      )}

      {/* Judge feedback — left aligned */}
      <div className="flex justify-start">
        <Card className="max-w-[85%] bg-amber-500/5 border-amber-200 dark:border-amber-800">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Scale className="h-4 w-4 text-amber-600" />
              <span className="text-xs font-medium text-amber-600">Judge</span>
              {turn.passed ? (
                <Badge variant="success" className="text-xs gap-1 ml-auto">
                  <CheckCircle2 className="h-3 w-3" /> Passed
                </Badge>
              ) : (
                <Badge variant="warning" className="text-xs gap-1 ml-auto">
                  <AlertCircle className="h-3 w-3" /> Incomplete
                </Badge>
              )}
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none max-h-96 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{turn.judgeFeedback}</ReactMarkdown>
            </div>

            {/* Criteria results inline */}
            {turn.criteriaResults && turn.criteriaResults.length > 0 && (
              <div className="mt-2 pt-2 border-t border-amber-200 dark:border-amber-800 space-y-1">
                {turn.criteriaResults.map((cr) => (
                  <div key={cr.criterionId} className="flex items-center gap-1.5 text-xs">
                    {cr.passed ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-600 shrink-0" />
                    ) : (
                      <AlertCircle className="h-3 w-3 text-red-500 shrink-0" />
                    )}
                    <span className="font-mono">{cr.criterionId}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
