// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  GATE_METADATA,
  GATE_ORDER,
  formatGateList,
  orderGateIds,
  type GateId,
} from "@/lib/gates";

interface GateCompatibilityPickerProps {
  value: GateId[] | undefined;
  onChange: (gates: GateId[] | undefined) => void;
  disabled?: boolean;
  /**
   * Gates that must always remain selected and cannot be unchecked (e.g. the
   * gate a criterion is being created for inline). Rendered checked + disabled.
   */
  lockedGates?: GateId[];
}

export function GateCompatibilityPicker({
  value,
  onChange,
  disabled,
  lockedGates,
}: GateCompatibilityPickerProps) {
  const selected = value ?? [];
  const selectedSet = new Set(selected);
  const lockedSet = new Set(lockedGates ?? []);
  const hasLocked = lockedSet.size > 0;

  const toggleGate = (gate: GateId) => {
    if (lockedSet.has(gate)) return;
    const next = selectedSet.has(gate)
      ? selected.filter((g) => g !== gate)
      : orderGateIds([...selected, gate]);
    // Selection must never be empty — keep at least one gate.
    if (next.length === 0) return;
    onChange(next);
  };

  const unselectAll = () => {
    if (!hasLocked) return;
    onChange(orderGateIds([...lockedSet]));
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {GATE_ORDER.map((gate) => {
          const meta = GATE_METADATA[gate];
          const isLocked = lockedSet.has(gate);
          return (
            <label
              key={gate}
              className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm hover:bg-accent/50"
            >
              <Checkbox
                checked={selectedSet.has(gate)}
                disabled={disabled || isLocked}
                onCheckedChange={() => toggleGate(gate)}
              />
              <span className="space-y-1">
                <span className="block font-medium">{meta.label}</span>
                <span className="block text-xs text-muted-foreground">{meta.description}</span>
              </span>
            </label>
          );
        })}
      </div>

      {hasLocked && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={unselectAll}
          className="h-auto px-2 py-1 text-xs text-muted-foreground"
        >
          Unselect all
        </Button>
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Effective compatibility:</span>
        <Badge variant="secondary" className="text-xs">{formatGateList(value)}</Badge>
      </div>
    </div>
  );
}
