// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { slugify } from "@/lib/utils";
import { toast } from "sonner";
import { gatesSatisfyInvariant, type GateId } from "@/lib/gates";

export interface UseCriteriaWizardOptions {
  /** Pre-populated parent dependency IDs */
  initialDependsOn?: string[];
  /** Pre-populated gate compatibility (defaults to ["select"]) */
  initialGates?: GateId[];
  /** Gates that cannot be unselected in the gate picker (e.g. inline creation) */
  lockedGates?: GateId[];
  /** Called with the new criterion ID after successful creation */
  onSuccess: (id: string) => void;
}

export function useCriteriaWizard({ initialDependsOn = [], initialGates, lockedGates, onSuccess }: UseCriteriaWizardOptions) {
  const queryClient = useQueryClient();

  // Wizard step (1 or 2)
  const [step, setStep] = useState(1);

  // Step 1 fields
  const [behavior, setBehavior] = useState("");
  const [id, setId] = useState("");
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [dependsOn, setDependsOn] = useState<string[]>(initialDependsOn);
  const [gates, setGates] = useState<GateId[] | undefined>(initialGates ?? ["select"]);

  // Step 2 fields
  const [prompt, setPrompt] = useState("");
  const [aiGenerated, setAiGenerated] = useState(false);

  // AI-suggested dependencies
  const [suggestedParents, setSuggestedParents] = useState<string[]>([]);
  const [suggestedChildren, setSuggestedChildren] = useState<string[]>([]);
  const [acceptedChildren, setAcceptedChildren] = useState<string[]>([]);

  // Fetch existing criteria to detect duplicate IDs (uses same cache as CriteriaPicker)
  const { data: existingCriteria = [], isLoading: criteriaLoading } = useQuery({
    queryKey: ["criteria"],
    queryFn: () => api.listCriteria(),
  });

  // ID validation
  const idValid = useMemo(() => /^[a-z][a-z0-9_]*$/.test(id), [id]);
  const idExists = useMemo(
    () => existingCriteria.some((c) => c.id === id.trim()),
    [id, existingCriteria],
  );
  const canContinue = behavior.trim().length > 0 && id.trim().length > 0 && idValid && !idExists && !criteriaLoading;

  // Gate compatibility lookup for parent/child suggestion filtering.
  const criterionGatesById = useMemo(() => {
    const map = new Map<string, GateId[] | undefined>();
    for (const c of existingCriteria) map.set(c.id, c.gates);
    return map;
  }, [existingCriteria]);

  // Keep parent/child selections consistent with the chosen gates. A parent must
  // be compatible with every gate this criterion applies to; a child may only be
  // compatible with a subset of them. Incompatible entries (e.g. AI suggestions
  // generated before the gates were narrowed) are pruned so the DAG invariant the
  // API enforces can never be violated from the wizard. Unknown ids (criteria not
  // yet loaded) are retained until their gates are known.
  useEffect(() => {
    setDependsOn((prev) => {
      const next = prev.filter(
        (pid) => !criterionGatesById.has(pid) || gatesSatisfyInvariant(criterionGatesById.get(pid), gates),
      );
      return next.length === prev.length ? prev : next;
    });
    setAcceptedChildren((prev) => {
      const next = prev.filter(
        (cid) => !criterionGatesById.has(cid) || gatesSatisfyInvariant(gates, criterionGatesById.get(cid)),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [gates, criterionGatesById, suggestedParents, suggestedChildren]);

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
    mutationFn: ({ behavior: behaviorText, gates: targetGates }: { behavior: string; gates?: GateId[] }) =>
      api.generateCriteriaPrompt(behaviorText, undefined, targetGates),
    onSuccess: (data) => {
      setPrompt(data.prompt);
      setAiGenerated(true);
      // Optionally update ID if not manually edited and suggestion is valid + unique
      if (!idManuallyEdited && data.suggestedId) {
        const suggested = data.suggestedId;
        const valid = /^[a-z][a-z0-9_]*$/.test(suggested);
        const exists = existingCriteria.some((c) => c.id === suggested);
        if (valid && !exists) {
          setId(suggested);
        }
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
      await Promise.allSettled(
        acceptedChildren.map(async (childId) => {
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
        }),
      );
      queryClient.invalidateQueries({ queryKey: ["criteria"] });
      toast.success(`Criterion "${data.id}" created`);
      onSuccess(data.id);
    },
  });

  // Step 1 → Step 2
  const handleContinue = useCallback(() => {
    setStep(2);
    generateMutation.mutate({ behavior: behavior.trim(), gates });
  }, [behavior, gates, generateMutation]);

  // Step 2 → Submit
  const handleCreate = useCallback(() => {
    if (!id.trim() || !prompt.trim()) return;
    createMutation.mutate({
      id: id.trim(),
      prompt: prompt.trim(),
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      gates,
    });
  }, [id, prompt, dependsOn, gates, createMutation]);

  // Regenerate prompt
  const handleRegenerate = useCallback(() => {
    setSuggestedParents([]);
    setSuggestedChildren([]);
    setAcceptedChildren([]);
    generateMutation.mutate({ behavior: behavior.trim(), gates });
  }, [behavior, gates, generateMutation]);

  // Reset all state to initial values
  const reset = useCallback(() => {
    setStep(1);
    setBehavior("");
    setId("");
    setIdManuallyEdited(false);
    setDependsOn(initialDependsOn);
    setGates(initialGates ?? ["select"]);
    setPrompt("");
    setAiGenerated(false);
    setSuggestedParents([]);
    setSuggestedChildren([]);
    setAcceptedChildren([]);
  }, [initialDependsOn, initialGates]);

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
    gates,
    setGates,
    lockedGates,
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
    criteriaLoading,
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
