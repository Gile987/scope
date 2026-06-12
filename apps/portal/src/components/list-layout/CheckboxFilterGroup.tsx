// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export interface CheckboxFilterOption {
  value: string;
  label: ReactNode;
  count?: number;
}

export interface CheckboxFilterGroupProps {
  options: readonly CheckboxFilterOption[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  className?: string;
}

/**
 * A vertical list of checkbox filter options. Multi-select.
 */
export function CheckboxFilterGroup({
  options,
  selected,
  onToggle,
  className,
}: CheckboxFilterGroupProps) {
  const selectedSet = new Set(selected);
  return (
    <div className={cn("flex flex-col gap-1.5", className)} role="group">
      {options.map((opt) => {
        const id = `cb-${opt.value}`;
        const isSelected = selectedSet.has(opt.value);
        return (
          <label
            key={opt.value}
            htmlFor={id}
            className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-sm hover:bg-accent/50"
          >
            <Checkbox
              id={id}
              checked={isSelected}
              onCheckedChange={() => onToggle(opt.value)}
            />
            <span className="flex-1 truncate">{opt.label}</span>
            {opt.count !== undefined && (
              <span className="text-xs text-muted-foreground tabular-nums">({opt.count})</span>
            )}
          </label>
        );
      })}
      {options.length === 0 && (
        <p className="px-1 py-0.5 text-xs text-muted-foreground">No options</p>
      )}
    </div>
  );
}
