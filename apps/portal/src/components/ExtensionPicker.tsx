// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { X, Search, Download, Loader2, Globe, Puzzle } from "lucide-react";
import type { ExtensionDocument, ExtensionSearchResult, ExtensionVersionInfo } from "@/types";
import { toast } from "sonner";

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Parse "id@version" → { id, version } or "id" → { id } */
function parseSpec(spec: string): { id: string; version?: string } {
  const at = spec.lastIndexOf("@");
  if (at > 0) return { id: spec.substring(0, at), version: spec.substring(at + 1) };
  return { id: spec };
}

/** Version selector for a single selected extension */
function VersionSelector({ extensionId, currentVersion, onVersionChange }: {
  extensionId: string;
  currentVersion?: string;
  onVersionChange: (version?: string) => void;
}) {
  const [showPreRelease, setShowPreRelease] = useState(false);

  const { data: versions = [], isLoading } = useQuery({
    queryKey: ["extension-versions", extensionId, showPreRelease],
    queryFn: () => api.getExtensionVersions(extensionId, showPreRelease),
  });

  return (
    <div className="flex items-center gap-2 pl-6">
      <Select
        value={currentVersion ?? "__latest__"}
        onValueChange={(v) => onVersionChange(v === "__latest__" ? undefined : v)}
      >
        <SelectTrigger className="h-7 w-44 text-xs font-mono">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__latest__">latest stable</SelectItem>
          {isLoading && <SelectItem value="__loading__" disabled>Loading…</SelectItem>}
          {versions.map((v: ExtensionVersionInfo) => (
            <SelectItem key={v.version} value={v.version}>
              {v.version}{v.preRelease ? " (pre-release)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-1.5">
        <Switch
          id={`pre-release-${extensionId}`}
          checked={showPreRelease}
          onCheckedChange={setShowPreRelease}
          className="h-4 w-7 [&>span]:h-3 [&>span]:w-3"
        />
        <Label htmlFor={`pre-release-${extensionId}`} className="text-[10px] text-muted-foreground cursor-pointer">
          Pre-release
        </Label>
      </div>
    </div>
  );
}

interface ExtensionPickerProps {
  selected: string[];
  onChange: (ids: string[]) => void;
  /** If true, hide selection badges — only show search+import (for ExtensionList page) */
  importOnly?: boolean;
  /** If true, show selected items as read-only (no remove, no search) */
  disabled?: boolean;
}

export function ExtensionPicker({ selected, onChange, importOnly = false, disabled = false }: ExtensionPickerProps) {
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);

  const debouncedQuery = useDebounce(query, 300);

  // Fetch all internal extensions
  const { data: internalExtensions = [], isLoading: loadingInternal } = useQuery({
    queryKey: ["extensions"],
    queryFn: () => api.listExtensions(),
  });

  const activeInternal = useMemo(
    () => internalExtensions.filter((e: ExtensionDocument) => !e.deletedAt),
    [internalExtensions],
  );

  // Search marketplace (debounced)
  const { data: searchResults = [], isFetching: fetchingSearch } = useQuery({
    queryKey: ["extensions-search", debouncedQuery],
    queryFn: () => api.searchExtensions(debouncedQuery, 10),
    enabled: debouncedQuery.length >= 2,
  });

  // Split search results into internal and external
  const internalMatches = useMemo(() => {
    if (!query.trim()) return importOnly ? [] : activeInternal.slice(0, 8);
    const q = query.toLowerCase();
    return activeInternal.filter(
      (e) =>
        e.id.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.publisher.toLowerCase().includes(q) ||
        (e.description?.toLowerCase().includes(q) ?? false),
    );
  }, [activeInternal, query, importOnly]);

  const internalIds = useMemo(
    () => new Set(activeInternal.map((e) => e.id)),
    [activeInternal],
  );

  const externalResults = useMemo(
    () => searchResults.filter((r: ExtensionSearchResult) => !r.internal && !internalIds.has(r.id)),
    [searchResults, internalIds],
  );

  // Unified list for keyboard navigation
  type ListItem =
    | { kind: "internal"; ext: ExtensionDocument }
    | { kind: "external"; result: ExtensionSearchResult };

  const items: ListItem[] = useMemo(() => {
    const list: ListItem[] = internalMatches.map((e) => ({
      kind: "internal" as const,
      ext: e,
    }));
    if (debouncedQuery.length >= 2) {
      externalResults.forEach((r) =>
        list.push({ kind: "external" as const, result: r }),
      );
    }
    return list;
  }, [internalMatches, externalResults, debouncedQuery]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [items.length]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Import mutation
  const importMutation = useMutation({
    mutationFn: (result: ExtensionSearchResult) =>
      api.createExtension({
        id: result.id,
        publisher: result.publisher,
        name: result.name,
        origin: "marketplace",
        ...(result.description ? { description: result.description } : {}),
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["extensions"] });
      toast.success(`Extension "${created.id}" imported`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to import extension");
    },
  });

  // Parse selected specs into a map for quick lookup
  const selectedMap = useMemo(() => {
    const map = new Map<string, string | undefined>(); // id → version|undefined
    for (const spec of selected) {
      const { id, version } = parseSpec(spec);
      map.set(id, version);
    }
    return map;
  }, [selected]);

  const toggleItem = useCallback(
    (id: string) => {
      if (importOnly) return;
      if (selectedMap.has(id)) {
        onChange(selected.filter((s) => parseSpec(s).id !== id));
      } else {
        onChange([...selected, id]); // Add without version (latest)
      }
      setQuery("");
      inputRef.current?.focus();
    },
    [selected, selectedMap, onChange, importOnly],
  );

  const removeItem = (id: string) => {
    onChange(selected.filter((s) => parseSpec(s).id !== id));
  };

  const updateVersion = useCallback(
    (id: string, version?: string) => {
      onChange(selected.map((spec) => {
        const parsed = parseSpec(spec);
        if (parsed.id === id) return version ? `${id}@${version}` : id;
        return spec;
      }));
    },
    [selected, onChange],
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
      const item = items[highlightIdx];
      if (item?.kind === "internal") {
        toggleItem(item.ext.id);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && !query && selected.length > 0 && !importOnly) {
      const lastSpec = selected[selected.length - 1];
      removeItem(parseSpec(lastSpec).id);
    }
  };

  if (loadingInternal) {
    return <Skeleton className="h-9 w-full" />;
  }

  const showDropdown = open && (items.length > 0 || (query && debouncedQuery.length >= 2 && fetchingSearch));

  return (
    <div ref={containerRef} className="relative space-y-2">
      {/* Selected extensions with version selectors */}
      {!importOnly && selected.length > 0 && (
        <div className="space-y-1.5">
          {selected.map((spec) => {
            const { id, version } = parseSpec(spec);
            return (
              <div key={id} className="rounded-md border p-2 space-y-1">
                <div className="flex items-center gap-1.5">
                  <Puzzle className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono text-xs font-medium flex-1">{id}</span>
                  {version && (
                    <Badge variant="outline" className="text-[10px] font-mono">{version}</Badge>
                  )}
                  {!version && (
                    <Badge variant="secondary" className="text-[10px]">latest</Badge>
                  )}
                  {!disabled && (
                    <X
                      className="h-3 w-3 cursor-pointer text-muted-foreground hover:text-destructive"
                      onClick={() => removeItem(id)}
                    />
                  )}
                </div>
                {!disabled && (
                  <VersionSelector
                    extensionId={id}
                    currentVersion={version}
                    onVersionChange={(v) => updateVersion(id, v)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Search input */}
      {!disabled && (
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search extensions…"
          className="h-9 pl-9 font-mono text-sm"
        />
        {fetchingSearch && debouncedQuery.length >= 2 && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>
      )}

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute z-50 top-full mt-1 w-full rounded-md border bg-popover shadow-md">
          <div className="max-h-64 overflow-y-auto p-1">
            {/* Internal results */}
            {internalMatches.length > 0 && (
              <>
                {debouncedQuery.length >= 2 && externalResults.length > 0 && (
                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Imported
                  </div>
                )}
                {internalMatches.map((ext, idx) => {
                  const isSelected = selectedMap.has(ext.id);
                  return (
                    <button
                      key={ext.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggleItem(ext.id)}
                      onMouseEnter={() => setHighlightIdx(idx)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-left text-sm transition-colors ${
                        idx === highlightIdx ? "bg-accent text-accent-foreground" : ""
                      } ${importOnly ? "cursor-default" : "cursor-pointer"}`}
                    >
                      {!importOnly && (
                        <span className={`flex items-center justify-center h-4 w-4 rounded border text-[10px] shrink-0 ${
                          isSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"
                        }`}>
                          {isSelected && "✓"}
                        </span>
                      )}
                      <Puzzle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-mono font-medium shrink-0">{ext.id}</span>
                      <span className="text-xs text-muted-foreground truncate">
                        {ext.name}{ext.description ? ` — ${ext.description}` : ""}
                      </span>
                    </button>
                  );
                })}
              </>
            )}

            {/* External (marketplace) results */}
            {debouncedQuery.length >= 2 && externalResults.length > 0 && (
              <>
                <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground mt-1 border-t pt-2">
                  <Globe className="inline h-3 w-3 mr-1" />
                  VS Code Marketplace
                </div>
                {externalResults.map((result, i) => {
                  const globalIdx = internalMatches.length + i;
                  return (
                    <div
                      key={result.id}
                      onMouseEnter={() => setHighlightIdx(globalIdx)}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm transition-colors ${
                        globalIdx === highlightIdx ? "bg-accent text-accent-foreground" : ""
                      }`}
                    >
                      <Globe className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-medium text-xs">{result.id}</span>
                          {result.version && (
                            <span className="text-[10px] text-muted-foreground">
                              v{result.version}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {result.name}{result.description ? ` — ${result.description}` : ""}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs gap-1 shrink-0"
                        disabled={importMutation.isPending}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          importMutation.mutate(result);
                        }}
                      >
                        {importMutation.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Download className="h-3 w-3" />
                        )}
                        Import
                      </Button>
                    </div>
                  );
                })}
              </>
            )}

            {/* Loading indicator */}
            {debouncedQuery.length >= 2 && fetchingSearch && externalResults.length === 0 && (
              <div className="px-2 py-2 text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Searching VS Code marketplace…
              </div>
            )}

            {/* Empty state */}
            {items.length === 0 && !fetchingSearch && query.trim() && (
              <div className="p-3 text-sm text-muted-foreground text-center">
                No matching extensions found
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
