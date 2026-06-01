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
  /** Whether the selected worker supports reasoning effort (undefined = unknown/not checked) */
  agentSupportsEffort?: boolean;
}

/**
 * Derives supportedEfforts from model capabilities and auto-clears
 * the effort value when the selected model doesn't support it.
 * Always includes "default" as a fallback option.
 */
export function useReasoningEffort({
  model,
  capabilitiesMap,
  value,
  onChange,
  agentSupportsEffort,
}: UseReasoningEffortOptions) {
  const capabilities = model ? capabilitiesMap.get(model) : undefined;
  const supportedEfforts = capabilities?.reasoningEffort ?? [];
  // Always include "default" as a valid option (for models without configurable effort)
  const allEfforts = supportedEfforts.length > 0 ? supportedEfforts : ["default"];

  useEffect(() => {
    if (allEfforts.length === 1 && value !== allEfforts[0]) {
      // Auto-select the only supported effort
      onChange(allEfforts[0]);
    } else if (value && !allEfforts.includes(value)) {
      onChange("");
    }
  }, [model, allEfforts, value, onChange]);

  // Worker doesn't support effort but model does
  const workerEffortWarning = allEfforts.length > 0 && agentSupportsEffort === false;

  return { supportedEfforts: allEfforts, capabilities, workerEffortWarning };
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
                <Badge key={e} variant="outline" className="text-xs font-medium bg-gray-200">
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
  /** Description text shown below the picker */
  description?: string;
  /** Show a warning that the worker doesn't support effort */
  workerEffortWarning?: boolean;
}

/**
 * Reasoning effort picker. Requires a selection — no "none" option.
 */
export function ReasoningEffortSelect({
  supportedEfforts,
  value,
  onChange,
  disabled,
  description,
  workerEffortWarning,
}: ReasoningEffortSelectProps) {
  if (supportedEfforts.length === 0) return null;

  return (
    <div className="space-y-2">
      <Label htmlFor="reasoningEffort">Reasoning Effort *</Label>
      <Select
        value={value || ""}
        onValueChange={(v) => onChange(v)}
        disabled={disabled}
      >
        <SelectTrigger id="reasoningEffort">
          <SelectValue placeholder="Select reasoning effort" />
        </SelectTrigger>
        <SelectContent>
          {supportedEfforts.map((level) => (
            <SelectItem key={level} value={level}>
              {level}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {workerEffortWarning && (
        <p className="text-xs text-amber-600">
          ⚠ The selected worker does not support reasoning effort selection. This setting may be ignored.
        </p>
      )}
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
