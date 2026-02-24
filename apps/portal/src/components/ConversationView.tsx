// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Bot, Scale, CheckCircle2, AlertCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { ConversationTurn } from "@/types";

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
 *   - Agent response (right-aligned, primary tint)
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
            {turn.toolCalls && turn.toolCalls.length > 0 && (
              <div className="mt-2 pt-2 border-t border-primary/10">
                <span className="text-xs text-muted-foreground">
                  {turn.toolCalls.length} tool call{turn.toolCalls.length !== 1 ? "s" : ""}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

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
