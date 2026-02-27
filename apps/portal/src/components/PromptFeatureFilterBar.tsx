// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Filter, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface PromptFeatureFilterBarProps {
  availableFeatures: string[];
  selectedFeatures: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  /** Override the card title (default: "Prompt Feature Filter") */
  title?: string;
  /** Override the description when nothing is selected */
  emptyDescription?: string;
  /** Override the description template when features are selected (receives count) */
  selectedDescription?: (count: number) => string;
}

export function PromptFeatureFilterBar({
  availableFeatures,
  selectedFeatures,
  onToggle,
  onClear,
  title = "Prompt Feature Filter",
  emptyDescription = "Click features to filter runs by task prompt characteristics.",
  selectedDescription = (count: number) =>
    `Showing runs whose task prompt has ${count} selected feature${count !== 1 ? "s" : ""} detected.`,
}: PromptFeatureFilterBarProps) {
  if (availableFeatures.length === 0) {
    return null;
  }

  const selectedSet = new Set(selectedFeatures);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          {selectedFeatures.length > 0 && (
            <button
              onClick={onClear}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              Clear all
            </button>
          )}
        </div>
        <CardDescription>
          {selectedFeatures.length === 0
            ? emptyDescription
            : selectedDescription(selectedFeatures.length)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-1.5">
          {availableFeatures.map((id) => {
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
