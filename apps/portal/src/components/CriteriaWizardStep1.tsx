// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GateCompatibilityPicker } from "@/components/GateCompatibilityPicker";
import { ObservationTaxonomySelect } from "@/components/ObservationTaxonomySelect";
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
    gates,
    setGates,
    lockedGates,
    kind,
    setKind,
    taxonomyElementId,
    setTaxonomyElementId,
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

      {/* Criteria kind */}
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}criteria-kind`} className="text-sm font-semibold">
          Criteria kind
        </Label>
        <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
          <SelectTrigger id={`${idPrefix}criteria-kind`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="gate">Gate — controls pass/fail iteration flow</SelectItem>
            <SelectItem value="observation">Observation — records per-iteration evidence</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Gate criteria drive judge feedback. Observations are recorded after each iteration and never gate the agent.
        </p>
      </div>

      {/* Gate compatibility */}
      {kind === "gate" ? (
        <div className="space-y-2">
          <Label className="text-sm font-semibold">Gate compatibility</Label>
          <GateCompatibilityPicker value={gates} onChange={setGates} lockedGates={lockedGates} />
          <p className="text-xs text-muted-foreground">
            Select the gates this criterion applies to. Parents must be compatible with every
            selected gate. This drives the gate-aware parent/child suggestions on the next step.
          </p>
        </div>
      ) : (
        <ObservationTaxonomySelect
          id={`${idPrefix}taxonomy`}
          value={taxonomyElementId}
          onChange={setTaxonomyElementId}
        />
      )}
    </div>
  );
}
