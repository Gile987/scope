// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ModelCapabilities } from "@/types";

// --- Hook: useModelCapabilities ---

export function useModelCapabilities(agentId: string | undefined) {
  const { data: agentModels = [] } = useQuery({
    queryKey: ["models", agentId],
    queryFn: () => api.listModels({ agentId: agentId! }),
    enabled: !!agentId,
  });

  const capabilitiesMap = new Map<string, ModelCapabilities>(
    agentModels
      .filter((m): m is typeof m & { capabilities: ModelCapabilities } => !!m.capabilities)
      .map((m) => [m.modelId, m.capabilities])
  );

  return { agentModels, capabilitiesMap };
}

// --- Hook: useReasoningEffort ---

export interface UseReasoningEffortOptions {
  model: string;
  capabilitiesMap: Map<string, ModelCapabilities>;
  value: string;
  onChange: (value: string) => void;
}

/**
 * Derives supportedEfforts from model capabilities and auto-clears
 * the effort value when the selected model doesn't support it.
 */
export function useReasoningEffort({
  model,
  capabilitiesMap,
  value,
  onChange,
}: UseReasoningEffortOptions) {
  const capabilities = model ? capabilitiesMap.get(model) : undefined;
  const supportedEfforts = capabilities?.reasoningEffort ?? [];

  useEffect(() => {
    if (supportedEfforts.length === 1 && value !== supportedEfforts[0]) {
      // Auto-select the only supported effort
      onChange(supportedEfforts[0]);
    } else if (value && !supportedEfforts.includes(value)) {
      onChange("");
    }
  }, [model, supportedEfforts, value, onChange]);

  return { supportedEfforts, capabilities };
}

// --- Component: ModelSelectItems ---

export interface ModelSelectItemsProps {
  models: string[];
  capabilitiesMap: Map<string, ModelCapabilities>;
  defaultModel?: string;
  excludeModel?: string;
}

/**
 * Renders model SelectItems with effort capability badges.
 * Use inside a <SelectContent>.
 */
export function ModelSelectItems({
  models,
  capabilitiesMap,
  defaultModel,
  excludeModel,
}: ModelSelectItemsProps) {
  const filtered = excludeModel
    ? models.filter((m) => m !== excludeModel)
    : models;

   return (
    <>
      {filtered.map((m) => {
        const caps = capabilitiesMap.get(m);
        const efforts = caps?.reasoningEffort;
        return (
          <SelectItem key={m} value={m}>
            <span className="flex items-center gap-1">
              {m}
              {m === defaultModel ? " (default)" : ""}
              {efforts && efforts.map((e) => (
                <Badge key={e} variant="outline" className="text-xs font-medium bg-gray-100">
                  {e}
                </Badge>
              ))}
            </span>
          </SelectItem>
        );
      })}
    </>
  );
}

// --- Component: ReasoningEffortSelect ---

export interface ReasoningEffortSelectProps {
  supportedEfforts: string[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Label for the "no selection" option */
  noSelectionLabel?: string;
  /** Description text shown below the picker */
  description?: string;
}

/**
 * Reasoning effort picker. Only renders when supportedEfforts has >1 option.
 */
export function ReasoningEffortSelect({
  supportedEfforts,
  value,
  onChange,
  disabled,
  noSelectionLabel = "Default (no override)",
  description,
}: ReasoningEffortSelectProps) {
  if (supportedEfforts.length === 0) return null;

  return (
    <div className="space-y-2">
      <Label htmlFor="reasoningEffort">Reasoning Effort</Label>
      <Select
        value={value || "__none__"}
        onValueChange={(v) => onChange(v === "__none__" ? "" : v)}
        disabled={disabled}
      >
        <SelectTrigger id="reasoningEffort">
          <SelectValue placeholder={noSelectionLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{noSelectionLabel}</SelectItem>
          {supportedEfforts.map((level) => (
            <SelectItem key={level} value={level}>
              {level}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
