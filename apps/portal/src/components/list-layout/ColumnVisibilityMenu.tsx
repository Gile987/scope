// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCallback, useState } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ColumnVisibilityOption {
  /** Stable column id (matches DataTableColumn.id). */
  id: string;
  /** Human-readable label shown in the menu. */
  label: string;
  /** When true, the column cannot be hidden (e.g. the primary identifier). */
  required?: boolean;
}

export interface ColumnVisibilityMenuProps {
  /** All toggleable columns. */
  columns: readonly ColumnVisibilityOption[];
  /** Currently hidden column ids. */
  hidden: ReadonlySet<string>;
  /** Toggle a single column's visibility. */
  onToggle: (id: string) => void;
  /** Optional reset handler — when supplied a Reset menu entry is shown. */
  onReset?: () => void;
  /** Button label (default: "Columns"). */
  buttonLabel?: string;
  /** Hide the button label and show only the icon. */
  iconOnly?: boolean;
}

/**
 * Dropdown menu that lets the user toggle which columns of a DataTable are
 * visible. Pair with `useHiddenColumns` for persistence.
 */
export function ColumnVisibilityMenu({
  columns,
  hidden,
  onToggle,
  onReset,
  buttonLabel = "Columns",
  iconOnly = false,
}: ColumnVisibilityMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Settings2 className="h-4 w-4" />
          {!iconOnly && buttonLabel}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.map((col) => (
          <DropdownMenuCheckboxItem
            key={col.id}
            checked={!hidden.has(col.id)}
            disabled={col.required}
            onCheckedChange={() => onToggle(col.id)}
            onSelect={(e) => e.preventDefault()}
          >
            {col.label}
          </DropdownMenuCheckboxItem>
        ))}
        {onReset && (
          <>
            <DropdownMenuSeparator />
            <button
              type="button"
              onClick={onReset}
              className="w-full px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              Reset to defaults
            </button>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface UseHiddenColumnsOptions {
  /** localStorage key suffix (the final key is `scope:hidden-columns:<key>`). */
  storageKey: string;
  /** Columns hidden by default. Applied only on first mount when no value is stored. */
  defaultHidden?: readonly string[];
}

export interface HiddenColumnsState {
  hidden: ReadonlySet<string>;
  isHidden: (id: string) => boolean;
  toggle: (id: string) => void;
  reset: () => void;
}

/**
 * localStorage-backed Set<string> tracking which columns are hidden.
 *
 * Storing the *hidden* set (rather than visible) means that columns added in
 * future releases default to visible, so users don't lose new functionality.
 */
export function useHiddenColumns({
  storageKey,
  defaultHidden = [],
}: UseHiddenColumnsOptions): HiddenColumnsState {
  const fullKey = `scope:hidden-columns:${storageKey}`;

  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(fullKey);
      if (raw) {
        const parsed = JSON.parse(raw) as string[];
        if (Array.isArray(parsed)) return new Set(parsed);
      }
    } catch {
      /* ignore */
    }
    return new Set(defaultHidden);
  });

  const persist = useCallback(
    (next: Set<string>) => {
      try {
        localStorage.setItem(fullKey, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
    },
    [fullKey],
  );

  const toggle = useCallback(
    (id: string) => {
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const reset = useCallback(() => {
    const next = new Set(defaultHidden);
    setHidden(next);
    persist(next);
  }, [defaultHidden, persist]);

  const isHidden = useCallback((id: string) => hidden.has(id), [hidden]);

  return { hidden, isHidden, toggle, reset };
}
