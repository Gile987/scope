// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * TaskPromptFeatures — shared component for displaying & extracting prompt
 * features on a task prompt entity. Used by:
 *   - TaskPromptList (creation dialog, step 2)
 *   - TaskPromptDetail (features card)
 *   - SubmitRun (step 2 review)
 *
 * Props:
 *   taskPromptId  — the task prompt to display features for
 *   autoExtract   — if true, triggers extraction on mount when no features exist
 *   compact       — if true, uses a more compact layout (no Card wrapper)
 */

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  Loader2, Sparkles, CheckCircle2, XCircle, MinusCircle, Plus, Check, RefreshCw,
} from "lucide-react";
import type { TaskPromptFeatureExtractionResult, SuggestedPromptFeature } from "@/types";
import { PromptFeatureWizard } from "@/components/PromptFeatureWizard";
import { toast } from "sonner";

interface TaskPromptFeaturesProps {
  taskPromptId: string;
  /** Auto-extract on mount if no features exist (default: true) */
  autoExtract?: boolean;
  /** Use compact layout without Card wrapper (default: false) */
  compact?: boolean;
}

export function TaskPromptFeatures({
  taskPromptId,
  autoExtract = true,
  compact = false,
}: TaskPromptFeaturesProps) {
  const queryClient = useQueryClient();
  const hasAutoExtracted = useRef(false);

  // Extraction result state — tracks the latest extraction response (includes suggestedFeatures)
  const [extraction, setExtraction] = useState<TaskPromptFeatureExtractionResult | null>(null);

  // Sheet wizard state
  const [activeSuggestion, setActiveSuggestion] = useState<SuggestedPromptFeature | null>(null);
  const [createdSuggestionIds, setCreatedSuggestionIds] = useState<Set<string>>(new Set());

  // Fetch the task prompt to check if features already exist
  const { data: taskPrompt } = useQuery({
    queryKey: ["task-prompt", taskPromptId],
    queryFn: () => api.getTaskPrompt(taskPromptId),
    enabled: !!taskPromptId,
  });

  const extractMutation = useMutation({
    mutationFn: (opts?: { force?: boolean }) =>
      api.extractTaskPromptFeatures(taskPromptId, { force: opts?.force }),
    onSuccess: (data) => {
      setExtraction(data);
      queryClient.invalidateQueries({ queryKey: ["task-prompt", taskPromptId] });
      queryClient.invalidateQueries({ queryKey: ["task-prompts"] });
    },
  });

  // Auto-extract on mount if autoExtract is true and no features exist
  useEffect(() => {
    if (
      autoExtract &&
      taskPrompt &&
      !taskPrompt.features?.length &&
      !hasAutoExtracted.current &&
      !extractMutation.isPending
    ) {
      hasAutoExtracted.current = true;
      extractMutation.mutate({});
    }
  }, [autoExtract, taskPrompt, extractMutation.isPending]);

  // Derive feature groups from extraction result or task prompt's stored features
  const features = extraction?.features ?? taskPrompt?.features ?? [];
  const detectedFeatures = features.filter((f) => f.detected);
  const notDetectedFeatures = features.filter((f) => !f.detected && f.evaluated);
  const skippedFeatures = features.filter((f) => !f.evaluated);
  const suggestedFeatures = extraction?.suggestedFeatures ?? [];
  const hasFeatures = taskPrompt?.features && taskPrompt.features.length > 0;

  const featuresContent = (
    <div className="space-y-4">
      {/* Header with extract/re-extract button */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          {!compact && (
            <h3 className="text-sm font-medium">Prompt Features</h3>
          )}
          <p className="text-xs text-muted-foreground">
            {extractMutation.isPending
              ? "Analyzing task prompt…"
              : extraction?.cached
                ? "Loaded from cache (same task text was analyzed before)"
                : taskPrompt?.featuresExtractedAt
                  ? `Last extracted ${new Date(taskPrompt.featuresExtractedAt).toLocaleString()}`
                  : "Features have not been extracted yet"}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => extractMutation.mutate({ force: true })}
          disabled={extractMutation.isPending}
        >
          {extractMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : hasFeatures ? (
            <RefreshCw className="h-4 w-4" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {hasFeatures ? "Re-extract" : "Extract Features"}
        </Button>
      </div>

      {/* Loading state */}
      {extractMutation.isPending && (
        <div className="flex items-center gap-2 text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Extracting prompt features…</span>
        </div>
      )}

      {/* Error state */}
      {extractMutation.isError && (
        <p className="text-sm text-destructive py-2">
          {extractMutation.error instanceof Error
            ? extractMutation.error.message
            : "Feature extraction failed"}
        </p>
      )}

      {/* Feature badges */}
      {features.length > 0 && !extractMutation.isPending && (
        <div className="space-y-3">
          {detectedFeatures.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                Detected ({detectedFeatures.length})
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {detectedFeatures.map((f) => (
                  <Link key={f.featureId} to={`/prompt-features/${f.featureId}`}>
                    <Badge variant="default" className="gap-1 font-mono text-xs cursor-pointer hover:bg-primary/80">
                      <CheckCircle2 className="h-3 w-3" />
                      {f.featureId}
                    </Badge>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {notDetectedFeatures.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                Not detected ({notDetectedFeatures.length})
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {notDetectedFeatures.map((f) => (
                  <Link key={f.featureId} to={`/prompt-features/${f.featureId}`}>
                    <Badge variant="outline" className="gap-1 font-mono text-xs text-muted-foreground cursor-pointer hover:bg-accent">
                      <XCircle className="h-3 w-3" />
                      {f.featureId}
                    </Badge>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {skippedFeatures.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                Skipped ({skippedFeatures.length})
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {skippedFeatures.map((f) => (
                  <Badge key={f.featureId} variant="outline" className="gap-1 font-mono text-xs text-muted-foreground/50">
                    <MinusCircle className="h-3 w-3" />
                    {f.featureId}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {features.length === 0 && (
            <p className="text-sm text-muted-foreground italic">No prompt features defined yet.</p>
          )}
        </div>
      )}

      {/* Suggested new features */}
      {suggestedFeatures.length > 0 && !extractMutation.isPending && (
        <>
          <Separator />
          <div className="space-y-3">
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-0.5">
                Suggested New Features
              </h4>
              <p className="text-xs text-muted-foreground">
                The AI detected characteristics not covered by existing features
              </p>
            </div>
            {suggestedFeatures.map((s) => {
              const alreadyCreated = createdSuggestionIds.has(s.suggestedId);
              return (
                <div
                  key={s.suggestedId}
                  className={`flex items-start justify-between gap-3 rounded-md border p-3 ${alreadyCreated ? "opacity-60" : ""}`}
                >
                  <div className="space-y-1 min-w-0">
                    <Badge variant="secondary" className="font-mono text-xs">
                      {s.suggestedId}
                    </Badge>
                    <p className="text-sm text-muted-foreground">{s.behavior}</p>
                  </div>
                  {alreadyCreated ? (
                    <Badge variant="outline" className="gap-1 shrink-0 text-xs">
                      <Check className="h-3 w-3" />
                      Created
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1 shrink-0"
                      onClick={() => setActiveSuggestion(s)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Sheet: Create Prompt Feature Wizard */}
      <Sheet
        open={activeSuggestion !== null}
        onOpenChange={(open) => {
          if (!open) setActiveSuggestion(null);
        }}
      >
        <SheetContent side="right" className="sm:max-w-xl w-full overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Create Prompt Feature</SheetTitle>
            <SheetDescription>
              Create a new feature suggested by the extraction analysis
            </SheetDescription>
          </SheetHeader>
          {activeSuggestion && (
            <div className="mt-6">
              <PromptFeatureWizard
                key={activeSuggestion.suggestedId}
                initialBehavior={activeSuggestion.behavior}
                initialId={activeSuggestion.suggestedId}
                initialPrompt={activeSuggestion.prompt}
                onCreated={(feature) => {
                  setCreatedSuggestionIds((prev) => new Set(prev).add(activeSuggestion.suggestedId));
                  setActiveSuggestion(null);
                  toast.success(`Feature "${feature.id}" created`);
                  // Re-extract with force to pick up the new feature
                  extractMutation.mutate({ force: true });
                }}
                onCancel={() => setActiveSuggestion(null)}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );

  return featuresContent;
}
