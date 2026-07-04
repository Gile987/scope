// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AgentOptionDescriptor } from "@/types";

interface AgentOptionsFieldsProps {
  /** Descriptors advertised by the selected worker (from agent.options). */
  descriptors?: AgentOptionDescriptor[];
  /** Current option values keyed by descriptor.key. */
  values: Record<string, unknown>;
  /** Called with the full next options bag whenever a control changes. */
  onChange: (next: Record<string, unknown>) => void;
}

/**
 * Renders per-worker agent option controls dynamically from the worker's
 * advertised descriptors. Boolean → Switch, enum → Select, number → numeric
 * Input, string → text Input. Renders nothing when the worker advertises no
 * options (e.g. Claude Code), so the section only appears where it applies —
 * mirroring how reasoning effort is gated by model capabilities.
 */
export function AgentOptionsFields({ descriptors, values, onChange }: AgentOptionsFieldsProps) {
  if (!descriptors || descriptors.length === 0) return null;

  const setValue = (key: string, value: unknown) => {
    const next = { ...values };
    if (value === undefined || value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  };

  return (
    <>
      {descriptors.map((d) => {
        const current = values[d.key];
        const controlId = `option-${d.key}`;

        if (d.type === "boolean") {
          const checked = current === undefined ? d.default === true : current === true;
          return (
            <div key={d.key} className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5 pr-4">
                <Label htmlFor={controlId}>{d.label}</Label>
                {d.description && <p className="text-xs text-muted-foreground">{d.description}</p>}
              </div>
              <Switch
                id={controlId}
                checked={checked}
                onCheckedChange={(v) => setValue(d.key, v)}
              />
            </div>
          );
        }

        if (d.type === "enum") {
          const value = current === undefined ? (d.default as string | undefined) ?? "" : String(current);
          return (
            <div key={d.key} className="space-y-2">
              <Label htmlFor={controlId}>{d.label}</Label>
              {d.description && <p className="text-xs text-muted-foreground">{d.description}</p>}
              <Select value={value} onValueChange={(v) => setValue(d.key, v)}>
                <SelectTrigger id={controlId}>
                  <SelectValue placeholder={`Select ${d.label.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  {(d.enum ?? []).map((opt) => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        }

        // string | number
        const value = current === undefined ? "" : String(current);
        return (
          <div key={d.key} className="space-y-2">
            <Label htmlFor={controlId}>{d.label}</Label>
            {d.description && <p className="text-xs text-muted-foreground">{d.description}</p>}
            <Input
              id={controlId}
              type={d.type === "number" ? "number" : "text"}
              value={value}
              onChange={(e) => {
                const raw = e.target.value;
                if (d.type === "number") {
                  setValue(d.key, raw === "" ? undefined : Number(raw));
                } else {
                  setValue(d.key, raw);
                }
              }}
            />
          </div>
        );
      })}
    </>
  );
}
