// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { CriteriaWizardState } from "@/hooks/useCriteriaWizard";

interface CriteriaWizardStep1Props {
  wizard: CriteriaWizardState;
  /** HTML id prefix to avoid collisions when rendered in different contexts */
  idPrefix?: string;
}

export function CriteriaWizardStep1({ wizard, idPrefix = "" }: CriteriaWizardStep1Props) {
  const {
    behavior,
    handleBehaviorChange,
    id,
    setId,
    setIdManuallyEdited,
    idValid,
    idExists,
    criteriaLoading,
  } = wizard;

  return (
    <div className="space-y-4">
      {/* Behavior description */}
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}behavior`} className="text-sm font-semibold">
          What behavior do you want to track?
        </Label>
        <Textarea
          id={`${idPrefix}behavior`}
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

      {/* Criteria ID */}
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}criteria-id`} className="text-sm font-semibold">
          Criteria ID{" "}
          <span className="font-normal text-muted-foreground">
            (when judge returns true)
          </span>
        </Label>
        <Input
          id={`${idPrefix}criteria-id`}
          placeholder="e.g., has_unit_tests"
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setIdManuallyEdited(true);
          }}
          pattern="[a-z][a-z0-9_]*"
          className="font-mono"
        />
        {id && !idValid && (
          <p className="text-xs text-destructive">
            Must start with a letter. Only lowercase letters, numbers, and underscores.
          </p>
        )}
        {id && idValid && idExists && (
          <p className="text-xs text-destructive">
            Criteria "{id}" already exists — choose a different ID
          </p>
        )}
        {id && idValid && criteriaLoading && (
          <p className="text-xs text-muted-foreground">
            Checking ID availability…
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {id && !wizard.idManuallyEdited
            ? "Auto-generated from behavior — edit to customize"
            : "This ID will be attached to evaluations when the judge evaluates them as positive"}
        </p>
      </div>
    </div>
  );
}
