// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Stepper } from "@/components/Stepper";
import { CriteriaPicker } from "@/components/CriteriaPicker";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  Check,
  X,
  Sparkles,
  RefreshCw,
  Pencil,
} from "lucide-react";

const STEPS = ["Define Criteria", "Review & Create"];

/** Convert a behavior description to a snake_case ID suggestion */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+/g, "_")
    .replace(/_$/, "")
    .slice(0, 40);
}

export function CreateCriterion() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Wizard step (1 or 2)
  const [step, setStep] = useState(1);

  // Step 1 fields
  const [behavior, setBehavior] = useState("");
  const [id, setId] = useState("");
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [idEditMode, setIdEditMode] = useState(false);
  const [dependsOn, setDependsOn] = useState<string[]>([]);

  // Step 2 fields
  const [prompt, setPrompt] = useState("");
  const [aiGenerated, setAiGenerated] = useState(false);
  const [aiModel, setAiModel] = useState("");

  // AI-suggested dependencies
  const [suggestedParents, setSuggestedParents] = useState<string[]>([]);
  const [suggestedChildren, setSuggestedChildren] = useState<string[]>([]);
  const [acceptedChildren, setAcceptedChildren] = useState<string[]>([]);

  // ID validation
  const idValid = useMemo(() => /^[a-z][a-z0-9_]*$/.test(id), [id]);
  const canContinue = behavior.trim().length > 0 && id.trim().length > 0 && idValid;

  // Auto-suggest ID from behavior (unless manually edited)
  const handleBehaviorChange = useCallback(
    (value: string) => {
      setBehavior(value);
      if (!idManuallyEdited) {
        setId(slugify(value));
      }
    },
    [idManuallyEdited],
  );

  // Generate prompt mutation
  const generateMutation = useMutation({
    mutationFn: (behaviorText: string) => api.generateCriteriaPrompt(behaviorText),
    onSuccess: (data) => {
      setPrompt(data.prompt);
      setAiGenerated(true);
      setAiModel("AI Generated");
      // Optionally update ID if not manually edited
      if (!idManuallyEdited && data.suggestedId) {
        setId(data.suggestedId);
      }
      // Merge suggested parents into dependsOn (additive with manual picks)
      if (data.suggestedParents?.length) {
        setSuggestedParents(data.suggestedParents);
        setDependsOn((prev) => [...new Set([...prev, ...data.suggestedParents])]);
      } else {
        setSuggestedParents([]);
      }
      // Store suggested children for accept/dismiss
      if (data.suggestedChildren?.length) {
        setSuggestedChildren(data.suggestedChildren);
        setAcceptedChildren(data.suggestedChildren);
      } else {
        setSuggestedChildren([]);
        setAcceptedChildren([]);
      }
    },
    onError: () => {
      // LLM unavailable — proceed with empty prompt for manual entry
      setPrompt("");
      setAiGenerated(false);
      setSuggestedParents([]);
      setSuggestedChildren([]);
      setAcceptedChildren([]);
    },
  });

  // Create criterion mutation
  const createMutation = useMutation({
    mutationFn: api.createCriterion,
    onSuccess: async (data) => {
      // Update accepted children to depend on the new criterion
      for (const childId of acceptedChildren) {
        try {
          const child = await api.getCriterion(childId);
          const existingDeps = child.dependsOn ?? [];
          if (!existingDeps.includes(data.id)) {
            await api.updateCriterion(childId, {
              dependsOn: [...existingDeps, data.id],
            });
          }
        } catch {
          // Non-blocking: child update failure doesn't prevent navigation
          console.warn(`Failed to update child criterion ${childId}`);
        }
      }
      queryClient.invalidateQueries({ queryKey: ["criteria"] });
      navigate(`/criteria/${data.id}`);
    },
  });

  // Step 1 → Step 2
  const handleContinue = () => {
    setStep(2);
    // Trigger AI prompt generation
    generateMutation.mutate(behavior.trim());
  };

  // Step 2 → Submit
  const handleCreate = () => {
    if (!id.trim() || !prompt.trim()) return;
    createMutation.mutate({
      id: id.trim(),
      prompt: prompt.trim(),
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    });
  };

  // Regenerate prompt
  const handleRegenerate = () => {
    setSuggestedParents([]);
    setSuggestedChildren([]);
    setAcceptedChildren([]);
    generateMutation.mutate(behavior.trim());
  };

  return (
    <div className="max-w-2xl mx-auto">
      {step === 1 ? (
        /* ───────────────────── Step 1: Define Criteria ───────────────────── */
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted">
                <Sparkles className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-semibold">Define Criteria</h1>
                <p className="text-sm text-muted-foreground">
                  Describe the behavior to evaluate
                </p>
              </div>
            </div>
            <Stepper steps={STEPS} currentStep={1} />
          </div>

          {/* Behavior description */}
          <Card>
            <CardContent className="pt-6 space-y-6">
              <div className="space-y-2">
                <Label htmlFor="behavior" className="text-sm font-semibold">
                  What behavior do you want to track?
                </Label>
                <Textarea
                  id="behavior"
                  placeholder="Describe the behavior or pattern you want to detect (e.g., 'uses Azure Bicep for IaC', 'has unit tests', 'follows REST conventions')"
                  value={behavior}
                  onChange={(e) => handleBehaviorChange(e.target.value)}
                  rows={4}
                  className="resize-none"
                />
                <p className="text-xs text-muted-foreground">
                  Describe what you want the judge to detect in your codebase
                </p>
              </div>

              {/* Criteria ID — tag/chip style */}
              <div className="space-y-2">
                <Label className="text-sm font-semibold">
                  Criteria ID{" "}
                  <span className="font-normal text-muted-foreground">
                    (when judge returns true)
                  </span>
                </Label>

                {id && !idEditMode ? (
                  /* Chip display mode */
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="secondary"
                      className="gap-1.5 px-3 py-1.5 text-sm font-mono cursor-pointer hover:bg-secondary/80"
                      onClick={() => setIdEditMode(true)}
                    >
                      <Check className="h-3.5 w-3.5" />
                      {id}
                      <X
                        className="h-3.5 w-3.5 ml-1 hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setId("");
                          setIdManuallyEdited(true);
                          setIdEditMode(true);
                        }}
                      />
                    </Badge>
                    <button
                      type="button"
                      onClick={() => setIdEditMode(true)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  /* Edit mode */
                  <div className="space-y-1">
                    <Input
                      placeholder="e.g., has_unit_tests"
                      value={id}
                      onChange={(e) => {
                        setId(e.target.value);
                        setIdManuallyEdited(true);
                      }}
                      onBlur={() => {
                        if (id) setIdEditMode(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && id) {
                          e.preventDefault();
                          setIdEditMode(false);
                        }
                      }}
                      pattern="[a-z][a-z0-9_]*"
                      className="font-mono"
                      autoFocus={idEditMode}
                    />
                    {id && !idValid && (
                      <p className="text-xs text-destructive">
                        Must start with a letter. Only lowercase letters, numbers, and underscores.
                      </p>
                    )}
                  </div>
                )}

                {!id && !idEditMode && (
                  <button
                    type="button"
                    onClick={() => setIdEditMode(true)}
                    className="flex items-center gap-2 px-3 py-2 border border-dashed rounded-md text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors w-full"
                  >
                    + Click to select or create criteria ID
                  </button>
                )}

                <p className="text-xs text-muted-foreground">
                  This ID will be attached to evaluations when the judge evaluates them as positive
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => navigate("/criteria")}>
              Cancel
            </Button>
            <Button
              onClick={handleContinue}
              disabled={!canContinue}
              className="gap-1.5"
            >
              Continue
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        /* ───────────────────── Step 2: Review & Create ───────────────────── */
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted">
                <Sparkles className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-semibold">Review & Create</h1>
                <p className="text-sm text-muted-foreground">
                  Confirm your criteria settings
                </p>
              </div>
            </div>
            <Stepper steps={STEPS} currentStep={2} />
          </div>

          {/* Summary card */}
          <Card>
            <CardContent className="pt-6 space-y-4">
              {/* Behavior & metadata row */}
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-semibold">
                    Criteria for: {behavior}
                  </p>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mt-1">
                    Behavior to track
                  </p>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                    Criteria ID
                  </p>
                  <Badge variant="secondary" className="font-mono">
                    {id}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Dependencies */}
          <Card>
            <CardContent className="pt-6 space-y-5">
              <div className="space-y-3">
                <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
                  Parents
                </Label>
                <CriteriaPicker selected={dependsOn} onChange={setDependsOn} aiSuggested={suggestedParents} />
                <p className="text-xs text-muted-foreground">
                  Criteria that must pass before this one is evaluated
                </p>
              </div>

              <Separator />

              <div className="space-y-3">
                <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
                  Children
                </Label>
                <CriteriaPicker selected={acceptedChildren} onChange={setAcceptedChildren} aiSuggested={suggestedChildren} />
                <p className="text-xs text-muted-foreground">
                  These criteria will be updated to depend on <span className="font-mono">{id || "this criterion"}</span> after creation
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Criteria Prompt */}
          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
                  {generateMutation.isPending
                    ? "Generating criteria prompt…"
                    : aiGenerated
                      ? `Criteria Prompt (${aiModel})`
                      : "Criteria Prompt"}
                </Label>

                {generateMutation.isPending ? (
                  <div className="flex items-center justify-center py-12 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" />
                    <span className="text-sm">Generating evaluation prompt…</span>
                  </div>
                ) : (
                  <Textarea
                    value={prompt}
                    onChange={(e) => {
                      setPrompt(e.target.value);
                      if (aiGenerated) setAiGenerated(false);
                    }}
                    rows={6}
                    placeholder="Write your evaluation prompt here. Describe what the judge should check for in the codebase…"
                    className="font-mono text-sm"
                  />
                )}

                {generateMutation.isError && (
                  <p className="text-xs text-amber-600">
                    AI generation unavailable — write your prompt manually
                  </p>
                )}
              </div>

              {/* Prompt action buttons */}
              {!generateMutation.isPending && (
                <div className="flex items-center gap-2">
                  {prompt && aiGenerated && (
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setAiGenerated(false)}
                    >
                      <Check className="h-3.5 w-3.5" />
                      Accept Prompt
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={handleRegenerate}
                    disabled={generateMutation.isPending}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Regenerate
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Error display */}
          {createMutation.isError && (
            <p className="text-sm text-destructive">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : "Creation failed"}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              onClick={() => setStep(1)}
              className="gap-1.5"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!prompt.trim() || createMutation.isPending}
              className="gap-1.5"
            >
              {createMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Create Criteria
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
