// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { slugify } from "@/lib/utils";
import { toast } from "sonner";

export interface UseCriteriaWizardOptions {
  /** Pre-populated parent dependency IDs */
  initialDependsOn?: string[];
  /** Called with the new criterion ID after successful creation */
  onSuccess: (id: string) => void;
}

export function useCriteriaWizard({ initialDependsOn = [], onSuccess }: UseCriteriaWizardOptions) {
  const queryClient = useQueryClient();

  // Wizard step (1 or 2)
  const [step, setStep] = useState(1);

  // Step 1 fields
  const [behavior, setBehavior] = useState("");
  const [id, setId] = useState("");
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [dependsOn, setDependsOn] = useState<string[]>(initialDependsOn);

  // Step 2 fields
  const [prompt, setPrompt] = useState("");
  const [aiGenerated, setAiGenerated] = useState(false);

  // AI-suggested dependencies
  const [suggestedParents, setSuggestedParents] = useState<string[]>([]);
  const [suggestedChildren, setSuggestedChildren] = useState<string[]>([]);
  const [acceptedChildren, setAcceptedChildren] = useState<string[]>([]);

  // Fetch existing criteria to detect duplicate IDs (uses same cache as CriteriaPicker)
  const { data: existingCriteria = [] } = useQuery({
    queryKey: ["criteria"],
    queryFn: () => api.listCriteria(),
  });

  // ID validation
  const idValid = useMemo(() => /^[a-z][a-z0-9_]*$/.test(id), [id]);
  const idExists = useMemo(
    () => existingCriteria.some((c) => c.id === id.trim()),
    [id, existingCriteria],
  );
  const canContinue = behavior.trim().length > 0 && id.trim().length > 0 && idValid && !idExists;

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
          // Non-blocking: child update failure doesn't prevent success
          console.warn(`Failed to update child criterion ${childId}`);
        }
      }
      queryClient.invalidateQueries({ queryKey: ["criteria"] });
      toast.success(`Criterion "${data.id}" created`);
      onSuccess(data.id);
    },
  });

  // Step 1 → Step 2
  const handleContinue = useCallback(() => {
    setStep(2);
    generateMutation.mutate(behavior.trim());
  }, [behavior, generateMutation]);

  // Step 2 → Submit
  const handleCreate = useCallback(() => {
    if (!id.trim() || !prompt.trim()) return;
    createMutation.mutate({
      id: id.trim(),
      prompt: prompt.trim(),
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    });
  }, [id, prompt, dependsOn, createMutation]);

  // Regenerate prompt
  const handleRegenerate = useCallback(() => {
    setSuggestedParents([]);
    setSuggestedChildren([]);
    setAcceptedChildren([]);
    generateMutation.mutate(behavior.trim());
  }, [behavior, generateMutation]);

  // Reset all state to initial values
  const reset = useCallback(() => {
    setStep(1);
    setBehavior("");
    setId("");
    setIdManuallyEdited(false);
    setDependsOn(initialDependsOn);
    setPrompt("");
    setAiGenerated(false);
    setSuggestedParents([]);
    setSuggestedChildren([]);
    setAcceptedChildren([]);
  }, [initialDependsOn]);

  return {
    // State
    step,
    setStep,
    behavior,
    id,
    setId,
    idManuallyEdited,
    setIdManuallyEdited,
    dependsOn,
    setDependsOn,
    prompt,
    setPrompt,
    aiGenerated,
    setAiGenerated,
    suggestedParents,
    suggestedChildren,
    acceptedChildren,
    setAcceptedChildren,

    // Computed
    idValid,
    idExists,
    canContinue,

    // Callbacks
    handleBehaviorChange,
    handleContinue,
    handleCreate,
    handleRegenerate,
    reset,

    // Mutations
    generateMutation,
    createMutation,
  };
}

export type CriteriaWizardState = ReturnType<typeof useCriteriaWizard>;
