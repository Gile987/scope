// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search } from "lucide-react";
import { truncate, formatId } from "@/lib/utils";

interface TaskPromptPickerProps {
  onSelect: (text: string) => void;
}

export function TaskPromptPicker({ onSelect }: TaskPromptPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["task-prompts-picker", query],
    queryFn: () => api.listTaskPrompts({ search: query || undefined, limit: 8 }),
  });

  const items = useMemo(() => data?.items ?? [], [data]);

  // Reset highlight when items change
  useEffect(() => {
    setHighlightIdx(0);
  }, [items]);

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

  const selectItem = useCallback(
    (text: string) => {
      onSelect(text);
      setQuery("");
      setOpen(false);
    },
    [onSelect],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (items[highlightIdx]) {
        selectItem(items[highlightIdx].text);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          placeholder="Search existing task prompts…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className="h-8 text-sm"
        />
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md max-h-[240px] overflow-y-auto">
          {isLoading ? (
            <div className="p-2 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground text-center">
              {query ? "No matching task prompts" : "No task prompts registered"}
            </div>
          ) : (
            <ul className="py-1">
              {items.map((tp, idx) => (
                <li
                  key={tp._id}
                  className={`px-3 py-2 cursor-pointer text-sm ${
                    idx === highlightIdx
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50"
                  }`}
                  onClick={() => selectItem(tp.text)}
                  onMouseEnter={() => setHighlightIdx(idx)}
                >
                  <span className="font-mono text-xs text-muted-foreground mr-2">
                    {formatId(tp._id)}
                  </span>
                  {truncate(tp.text.replace(/\n/g, " "), 80)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
