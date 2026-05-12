// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { X, Sparkles } from "lucide-react";

interface CriteriaPickerProps {
  selected: string[];
  onChange: (ids: string[]) => void;
  /** IDs that were AI-suggested — shown with a sparkle indicator */
  aiSuggested?: string[];
  /** HTML id for the underlying input — enables label-to-control association */
  inputId?: string;
}

export function CriteriaPicker({ selected, onChange, aiSuggested = [], inputId }: CriteriaPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: criteria = [], isLoading } = useQuery({
    queryKey: ["criteria"],
    queryFn: () => api.listCriteria(),
  });

  // Filter: show unselected criteria matching query
  const suggestions = useMemo(() => {
    const available = criteria.filter((c) => !selected.includes(c.id));
    if (!query.trim()) return available.slice(0, 8);
    const q = query.toLowerCase();
    return available.filter(
      (c) => c.id.toLowerCase().includes(q) || c.prompt.toLowerCase().includes(q),
    );
  }, [criteria, selected, query]);

  // Reset highlight when suggestions change
  useEffect(() => {
    setHighlightIdx(0);
  }, [suggestions]);

  // Close dropdown on outside click (checks both input area and portal dropdown)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inContainer = containerRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inContainer && !inDropdown) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const addItem = useCallback(
    (id: string) => {
      if (!selected.includes(id)) {
        onChange([...selected, id]);
      }
      setQuery("");
      setOpen(false);
      inputRef.current?.focus();
    },
    [selected, onChange],
  );

  const removeItem = (id: string) => {
    onChange(selected.filter((s) => s !== id));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions[highlightIdx]) {
        addItem(suggestions[highlightIdx].id);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && !query && selected.length > 0) {
      removeItem(selected[selected.length - 1]);
    }
  };

  // Compute fixed position for portal-based dropdown so it isn't clipped by
  // overflow-y-auto scroll containers (e.g. dialogs).
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    if (!open || !inputRef.current) return;
    let rafId: number | undefined;

    const updatePosition = () => {
      const rect = inputRef.current!.getBoundingClientRect();
      setDropdownStyle((prev) => {
        const nextStyle: React.CSSProperties = {
          position: "fixed",
          top: rect.bottom + 4,
          left: rect.left,
          width: rect.width,
          zIndex: 50,
        };

        if (
          prev.position === nextStyle.position &&
          prev.top === nextStyle.top &&
          prev.left === nextStyle.left &&
          prev.width === nextStyle.width &&
          prev.zIndex === nextStyle.zIndex
        ) {
          return prev;
        }

        return nextStyle;
      });
    };

    const scheduleUpdatePosition = () => {
      if (rafId !== undefined) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = undefined;
        updatePosition();
      });
    };
    updatePosition();

    window.addEventListener("scroll", scheduleUpdatePosition, true);
    window.addEventListener("resize", scheduleUpdatePosition);
    return () => {
      if (rafId !== undefined) {
        window.cancelAnimationFrame(rafId);
      }
      window.removeEventListener("scroll", scheduleUpdatePosition, true);
      window.removeEventListener("resize", scheduleUpdatePosition);
    };
  }, [open]);

  if (isLoading) {
    return <Skeleton className="h-9 w-full" />;
  }

  return (
    <div ref={containerRef} className="space-y-2">
      {/* Selected badges */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <Badge
              key={id}
              variant="secondary"
              className="gap-1 font-mono text-xs"
            >
              {aiSuggested.includes(id) && (
                <Sparkles className="h-3 w-3 text-amber-500" />
              )}
              {id}
              <X
                className="h-3 w-3 cursor-pointer hover:text-destructive"
                onClick={() => removeItem(id)}
              />
            </Badge>
          ))}
        </div>
      )}

      {/* Typeahead input */}
      <Input
        ref={inputRef}
        id={inputId}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="Type to search criteria…"
        className="h-9 font-mono text-sm"
      />

      {/* Dropdown suggestions (portal-based to avoid clipping by scroll containers) */}
      {open && suggestions.length > 0 && createPortal(
        <div ref={dropdownRef} style={dropdownStyle} className="rounded-md border bg-popover shadow-md">
          <div className="max-h-48 overflow-y-auto p-1">
            {suggestions.map((c, idx) => (
              <button
                key={c.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addItem(c.id)}
                onMouseEnter={() => setHighlightIdx(idx)}
                className={`w-full flex items-start gap-2 px-2 py-1.5 rounded-sm text-left text-sm transition-colors ${
                  idx === highlightIdx ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                <span className="font-mono font-medium shrink-0">{c.id}</span>
                <span className="text-xs text-muted-foreground truncate">
                  {c.prompt}
                </span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}

      {open && query && suggestions.length === 0 && createPortal(
        <div style={dropdownStyle} className="rounded-md border bg-popover shadow-md p-3 text-sm text-muted-foreground text-center">
          No matching criteria
        </div>,
        document.body,
      )}
    </div>
  );
}
