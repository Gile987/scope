// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { HelpTooltip } from "@/components/HelpTooltip";
import { cn } from "@/lib/utils";

export interface AdvancedModeToggleProps {
  /** Whether advanced mode is currently on. */
  checked: boolean;
  /** Called when the user flips the switch. */
  onCheckedChange: (value: boolean) => void;
  /**
   * DOM id for the underlying switch. Lets a wrapping form associate a label
   * or programmatic focus target with the control. Defaults to "advanced-mode".
   */
  id?: string;
  /** Visible caption next to the switch. Defaults to "Advanced". */
  label?: string;
  /** Tooltip explanation shown next to the label. */
  helpText?: React.ReactNode;
  className?: string;
}

const DEFAULT_HELP_TEXT =
  "Reveal power-user settings (Agent version, Priority) across the form. Your choice is remembered.";

/**
 * Pill-shaped Advanced toggle used in the Submit Run header. Controlled
 * component — pair it with the {@link useAdvancedMode} hook so the same
 * preference can drive other fields on the page and persist to localStorage.
 */
export function AdvancedModeToggle({
  checked,
  onCheckedChange,
  id = "advanced-mode",
  label = "Advanced",
  helpText = DEFAULT_HELP_TEXT,
  className,
}: AdvancedModeToggleProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-full border bg-card px-3 py-1.5",
        className,
      )}
    >
      <Label htmlFor={id} className="cursor-pointer text-xs font-medium">
        {label}
      </Label>
      <HelpTooltip text={helpText} />
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label="Toggle advanced options"
      />
    </div>
  );
}
