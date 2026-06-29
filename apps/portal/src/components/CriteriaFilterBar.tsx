// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Filter, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { CriterionKind } from "@/types";

interface CriteriaFilterBarProps {
  availableCriteria: string[];
  selectedCriteria: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  /** Override the card title (default: "Success Criteria Filter") */
  title?: string;
  /** Override the description when nothing is selected */
  emptyDescription?: string;
  /** Override the description template when criteria are selected (receives count) */
  selectedDescription?: (count: number) => string;
  /** Optional kind metadata for rendering gate/observation filter chips. */
  criteriaKinds?: Record<string, CriterionKind | undefined>;
  selectedKinds?: CriterionKind[];
  onToggleKind?: (kind: CriterionKind) => void;
}

export function CriteriaFilterBar({
  availableCriteria,
  selectedCriteria,
  onToggle,
  onClear,
  title = "Success Criteria Filter",
  emptyDescription = "Click criteria to filter runs and redefine success. Default: all criteria in each run must pass.",
  selectedDescription = (count: number) =>
    `Success = all ${count} selected criteria pass. Runs without these criteria are excluded.`,
  criteriaKinds,
  selectedKinds = [],
  onToggleKind,
}: CriteriaFilterBarProps) {
  if (availableCriteria.length === 0) {
    return null;
  }

  const selectedSet = new Set(selectedCriteria);
  const selectedKindSet = new Set(selectedKinds);
  const kindCounts = criteriaKinds
    ? {
        gate: availableCriteria.filter((id) => (criteriaKinds[id] ?? "gate") === "gate").length,
        observation: availableCriteria.filter((id) => criteriaKinds[id] === "observation").length,
      }
    : undefined;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          {selectedCriteria.length > 0 && (
            <button
              onClick={onClear}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              Clear all
            </button>
          )}
        </div>
        <CardDescription>
          {selectedCriteria.length === 0
            ? emptyDescription
            : selectedDescription(selectedCriteria.length)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {kindCounts && onToggleKind && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {(["gate", "observation"] as const).map((kind) => (
              <Badge
                key={kind}
                variant={selectedKindSet.has(kind) ? "default" : "outline"}
                className="cursor-pointer capitalize transition-colors hover:bg-muted"
                onClick={() => onToggleKind(kind)}
              >
                {kind} ({kindCounts[kind]})
              </Badge>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {availableCriteria.map((id) => {
            const isSelected = selectedSet.has(id);
            return (
              <Badge
                key={id}
                variant={isSelected ? "default" : "outline"}
                className={`cursor-pointer transition-colors ${
                  isSelected
                    ? "bg-primary hover:bg-primary/80"
                    : "hover:bg-muted"
                }`}
                onClick={() => onToggle(id)}
              >
                {id}
                {isSelected && <X className="ml-1 h-3 w-3" />}
              </Badge>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
