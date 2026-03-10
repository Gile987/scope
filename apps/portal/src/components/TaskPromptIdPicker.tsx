// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { X } from "lucide-react";
import { truncate, formatId } from "@/lib/utils";

interface TaskPromptIdPickerProps {
  selected: string[];
  onChange: (ids: string[]) => void;
}

export function TaskPromptIdPicker({ selected, onChange }: TaskPromptIdPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["task-prompts-picker", query],
    queryFn: () => api.listTaskPrompts({ search: query || undefined, limit: 20 }),
  });

  const items = useMemo(() => data?.items ?? [], [data]);

  // Filter out already-selected items
  const suggestions = useMemo(() => {
    return items.filter((tp) => !selected.includes(tp._id));
  }, [items, selected]);

  // Resolve selected IDs to their text (for badge display)
  const { data: allPrompts } = useQuery({
    queryKey: ["task-prompts-picker", ""],
    queryFn: () => api.listTaskPrompts({ limit: 100 }),
  });

  const promptMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const tp of allPrompts?.items ?? []) {
      map.set(tp._id, tp.text);
    }
    return map;
  }, [allPrompts]);

  // Reset highlight when suggestions change
  useEffect(() => {
    setHighlightIdx(0);
  }, [suggestions]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
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
        addItem(suggestions[highlightIdx]._id);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && !query && selected.length > 0) {
      removeItem(selected[selected.length - 1]);
    }
  };

  if (isLoading) {
    return <Skeleton className="h-9 w-full" />;
  }

  return (
    <div ref={containerRef} className="relative space-y-2">
      {/* Selected badges */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <Badge
              key={id}
              variant="secondary"
              className="gap-1 text-xs max-w-xs"
            >
              <span className="font-mono shrink-0">{formatId(id)}</span>
              {promptMap.has(id) && (
                <span className="text-muted-foreground truncate">
                  {truncate(promptMap.get(id)!.replace(/\n/g, " "), 40)}
                </span>
              )}
              <X
                className="h-3 w-3 cursor-pointer hover:text-destructive shrink-0"
                onClick={() => removeItem(id)}
              />
            </Badge>
          ))}
        </div>
      )}

      {/* Typeahead input */}
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="Type to search task prompts…"
        className="h-9 text-sm"
      />

      {/* Dropdown suggestions */}
      {open && suggestions.length > 0 && (
        <div className="absolute z-50 top-full mt-1 w-full rounded-md border bg-popover shadow-md">
          <div className="max-h-48 overflow-y-auto p-1">
            {suggestions.map((tp, idx) => (
              <button
                key={tp._id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addItem(tp._id)}
                onMouseEnter={() => setHighlightIdx(idx)}
                className={`w-full flex items-start gap-2 px-2 py-1.5 rounded-sm text-left text-sm transition-colors ${
                  idx === highlightIdx ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                <span className="font-mono text-xs text-muted-foreground shrink-0">
                  {formatId(tp._id)}
                </span>
                <span className="text-xs truncate">
                  {truncate(tp.text.replace(/\n/g, " "), 80)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {open && query && suggestions.length === 0 && (
        <div className="absolute z-50 top-full mt-1 w-full rounded-md border bg-popover shadow-md p-3 text-sm text-muted-foreground text-center">
          No matching task prompts
        </div>
      )}
    </div>
  );
}
