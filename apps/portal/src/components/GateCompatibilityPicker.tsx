// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

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
}

export function GateCompatibilityPicker({ value, onChange, disabled }: GateCompatibilityPickerProps) {
  const selected = value ?? [];
  const allGates = selected.length === 0;
  const selectedSet = new Set(selected);

  const toggleGate = (gate: GateId) => {
    const next = selectedSet.has(gate)
      ? selected.filter((g) => g !== gate)
      : orderGateIds([...selected, gate]);
    onChange(next.length > 0 ? next : undefined);
  };

  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm hover:bg-accent/50">
        <Checkbox
          checked={allGates}
          disabled={disabled}
          onCheckedChange={(checked) => {
            onChange(checked ? undefined : [...GATE_ORDER]);
          }}
        />
        <span className="space-y-1">
          <span className="block font-medium">All gates</span>
          <span className="block text-xs text-muted-foreground">
            Compatible everywhere. Use this for shared ancestor criteria.
          </span>
        </span>
      </label>

      <div className={allGates ? "opacity-60" : ""}>
        <div className="grid gap-2 sm:grid-cols-2">
          {GATE_ORDER.map((gate) => {
            const meta = GATE_METADATA[gate];
            return (
              <label
                key={gate}
                className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm hover:bg-accent/50"
              >
                <Checkbox
                  checked={allGates || selectedSet.has(gate)}
                  disabled={disabled || allGates}
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
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Effective compatibility:</span>
        <Badge variant="secondary" className="text-xs">{formatGateList(value)}</Badge>
      </div>
    </div>
  );
}
