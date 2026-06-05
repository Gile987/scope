// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface DateRangeFilterProps {
  /** ISO date string `YYYY-MM-DD` (inclusive lower bound) or null when unset. */
  from: string | null;
  /** ISO date string `YYYY-MM-DD` (inclusive upper bound) or null when unset. */
  to: string | null;
  onChange: (from: string | null, to: string | null) => void;
}

interface Preset {
  label: string;
  /** Returns the [from, to] pair in local `YYYY-MM-DD` strings. */
  range: () => [string, string];
}

const toLocalDateString = (d: Date): string => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const startOfToday = (): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const PRESETS: Preset[] = [
  {
    label: "Today",
    range: () => {
      const t = toLocalDateString(startOfToday());
      return [t, t];
    },
  },
  {
    label: "Last 7 days",
    range: () => {
      const end = startOfToday();
      const start = new Date(end);
      start.setDate(start.getDate() - 6);
      return [toLocalDateString(start), toLocalDateString(end)];
    },
  },
  {
    label: "Last 30 days",
    range: () => {
      const end = startOfToday();
      const start = new Date(end);
      start.setDate(start.getDate() - 29);
      return [toLocalDateString(start), toLocalDateString(end)];
    },
  },
  {
    label: "Last 90 days",
    range: () => {
      const end = startOfToday();
      const start = new Date(end);
      start.setDate(start.getDate() - 89);
      return [toLocalDateString(start), toLocalDateString(end)];
    },
  },
  {
    label: "This month",
    range: () => {
      const now = startOfToday();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return [toLocalDateString(start), toLocalDateString(now)];
    },
  },
  {
    label: "This year",
    range: () => {
      const now = startOfToday();
      const start = new Date(now.getFullYear(), 0, 1);
      return [toLocalDateString(start), toLocalDateString(now)];
    },
  },
];

function isActivePreset(preset: Preset, from: string | null, to: string | null): boolean {
  if (!from || !to) return false;
  const [pFrom, pTo] = preset.range();
  return pFrom === from && pTo === to;
}

export function DateRangeFilter({ from, to, onChange }: DateRangeFilterProps) {
  const hasValue = !!(from || to);

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-1">
        {PRESETS.map((p) => {
          const active = isActivePreset(p, from, to);
          return (
            <Button
              key={p.label}
              type="button"
              variant={active ? "secondary" : "ghost"}
              size="sm"
              className={cn("h-7 justify-start text-xs", !active && "text-muted-foreground")}
              onClick={() => {
                const [f, t] = p.range();
                onChange(f, t);
              }}
            >
              {p.label}
            </Button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <div className="space-y-0.5">
          <label
            className="block text-[10px] uppercase tracking-wide text-muted-foreground"
            htmlFor="date-range-from"
          >
            From
          </label>
          <Input
            id="date-range-from"
            type="date"
            value={from ?? ""}
            max={to ?? undefined}
            onChange={(e) => onChange(e.target.value || null, to)}
            className="h-7 px-2 text-xs"
          />
        </div>
        <div className="space-y-0.5">
          <label
            className="block text-[10px] uppercase tracking-wide text-muted-foreground"
            htmlFor="date-range-to"
          >
            To
          </label>
          <Input
            id="date-range-to"
            type="date"
            value={to ?? ""}
            min={from ?? undefined}
            onChange={(e) => onChange(from, e.target.value || null)}
            className="h-7 px-2 text-xs"
          />
        </div>
      </div>

      {hasValue && (
        <button
          type="button"
          className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => onChange(null, null)}
        >
          Clear date range
        </button>
      )}
    </div>
  );
}
