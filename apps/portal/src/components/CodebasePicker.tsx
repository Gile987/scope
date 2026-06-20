// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CodebaseDocument, CodebaseRevisionDocument } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CodebaseCreateForm } from "@/components/CodebaseCreateForm";
import { ChevronDown, ChevronUp, FileArchive, FolderGit2, Loader2, Search, Upload, X } from "lucide-react";
import { toast } from "sonner";

interface CodebasePickerProps {
  selected: string | null;
  onChange: (spec: string | null) => void;
  disabled?: boolean;
}

function parseCodebaseSpec(spec: string | null): { slug: string; revisionRef?: string } | null {
  if (!spec) return null;
  const at = spec.lastIndexOf("@r");
  if (at > 0) return { slug: spec.substring(0, at), revisionRef: spec };
  return { slug: spec };
}

export function CodebasePicker({ selected, onChange, disabled = false }: CodebasePickerProps) {
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: codebases = [], isLoading } = useQuery({ queryKey: ["codebases"], queryFn: () => api.listCodebases() });
  const activeCodebases = useMemo(() => codebases.filter((c: CodebaseDocument) => !c.deletedAt), [codebases]);
  const parsed = useMemo(() => parseCodebaseSpec(selected), [selected]);
  const selectedCodebase = useMemo(
    () => activeCodebases.find((c) => c.slug === parsed?.slug || c._id === parsed?.slug) ?? null,
    [activeCodebases, parsed?.slug],
  );

  const { data: revisions = [], isLoading: loadingRevisions } = useQuery({
    queryKey: ["codebase-revisions", selectedCodebase?._id],
    queryFn: () => api.listCodebaseRevisions(selectedCodebase!._id, 20),
    enabled: !!selectedCodebase,
  });

  const matches = useMemo(() => {
    if (!query.trim()) return activeCodebases.slice(0, 8);
    const q = query.toLowerCase();
    return activeCodebases.filter((c) => `${c.slug} ${c.name} ${c.source ?? ""} ${c.description ?? ""}`.toLowerCase().includes(q));
  }, [activeCodebases, query]);

  useEffect(() => setHighlightIdx(0), [matches.length]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const uploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadCodebaseArchive(selectedCodebase!._id, file),
    onSuccess: (revision) => {
      queryClient.invalidateQueries({ queryKey: ["codebases"] });
      queryClient.invalidateQueries({ queryKey: ["codebase-revisions", selectedCodebase?._id] });
      onChange(revision.ref);
      toast.success(`Uploaded ${revision.ref}`);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to upload archive"),
  });

  const selectCodebase = (codebase: CodebaseDocument) => {
    onChange(codebase.slug);
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  };

  const clear = () => onChange(null);

  const showDropdown = open && (matches.length > 0 || query.trim().length > 0);

  if (isLoading) return <Skeleton className="h-9 w-full" />;

  return (
    <div ref={containerRef} className="relative space-y-2">
      {selected && !selectedCodebase && (
        <div className="flex items-center gap-2 rounded-md border p-2">
          <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="flex-1 font-mono text-xs">{selected}</span>
          <Badge variant="secondary" className="text-[10px]">resolved revision</Badge>
          {!disabled && <X className="h-3 w-3 cursor-pointer text-muted-foreground hover:text-destructive" onClick={clear} />}
        </div>
      )}

      {selectedCodebase ? (
        <div className="rounded-md border p-2 space-y-2">
          <div className="flex items-center gap-1.5">
            <CodebaseIcon codebase={selectedCodebase} />
            <span className="font-mono text-xs font-medium">{selectedCodebase.slug}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{selectedCodebase.name}</span>
            <Badge variant="outline" className="text-[10px]">{selectedCodebase.sourceType}</Badge>
            {!disabled && <X className="h-3 w-3 cursor-pointer text-muted-foreground hover:text-destructive" onClick={clear} />}
          </div>
          <div className="pl-6 space-y-2">
            {selectedCodebase.sourceType === "git" && (
              <div className="space-y-1">
                <Label className="text-xs">Revision</Label>
                <Select value={parsed?.revisionRef ?? "__latest__"} onValueChange={(v) => onChange(v === "__latest__" ? selectedCodebase.slug : v)} disabled={disabled}>
                  <SelectTrigger className="h-8 w-full text-xs font-mono"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__latest__">latest at submit ({selectedCodebase.defaultBranch ?? "default branch"})</SelectItem>
                    {loadingRevisions && <SelectItem value="__loading__" disabled>Loading…</SelectItem>}
                    {revisions.map((revision: CodebaseRevisionDocument, idx: number) => (
                      <SelectItem key={revision._id} value={revision.ref}>{revision.ref}{idx === 0 ? " (latest resolved)" : ""} — {shortSha(revision.resolvedCommitSha) ?? shortSha(revision.contentSha256) ?? "snapshot"}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">Bare git selections resolve a fresh revision when the run is submitted.</p>
              </div>
            )}
            {selectedCodebase.sourceType === "archive" && (
              <div className="space-y-2">
                <Label className="text-xs">Archive revision</Label>
                <Select value={parsed?.revisionRef ?? revisions[0]?.ref ?? "__none__"} onValueChange={(v) => onChange(v === "__none__" ? selectedCodebase.slug : v)} disabled={disabled || revisions.length === 0}>
                  <SelectTrigger className="h-8 w-full text-xs font-mono"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {revisions.length === 0 && <SelectItem value="__none__">No archive uploaded</SelectItem>}
                    {revisions.map((revision: CodebaseRevisionDocument, idx: number) => (
                      <SelectItem key={revision._id} value={revision.ref}>{revision.ref}{idx === 0 ? " (latest)" : ""} — {revision.originalFilename ?? "archive"}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!disabled && (
                  <div>
                    <input ref={uploadInputRef} type="file" className="hidden" accept=".zip,.tar,.tgz,.tar.gz,.gz" onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadMutation.mutate(file); }} />
                    <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" disabled={uploadMutation.isPending} onClick={() => uploadInputRef.current?.click()}>
                      {uploadMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                      Upload archive
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : !selected ? (
        <div className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          None selected — runs start from an empty workspace.
        </div>
      ) : null}

      {!disabled && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setHighlightIdx((i) => Math.min(i + 1, matches.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx((i) => Math.max(i - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); const item = matches[highlightIdx]; if (item) selectCodebase(item); }
              else if (e.key === "Escape") setOpen(false);
            }}
            placeholder="Search codebases…"
            className="h-9 pl-9 font-mono text-sm"
          />
        </div>
      )}

      {showDropdown && (
        <div className="absolute top-full z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          <div className="max-h-64 overflow-y-auto p-1">
            {matches.map((codebase, idx) => (
              <button
                key={codebase._id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectCodebase(codebase)}
                onMouseEnter={() => setHighlightIdx(idx)}
                className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors ${idx === highlightIdx ? "bg-accent text-accent-foreground" : ""}`}
              >
                <CodebaseIcon codebase={codebase} />
                <span className="shrink-0 font-mono font-medium">{codebase.slug}</span>
                <Badge variant="outline" className="text-[10px]">{codebase.sourceType}</Badge>
                <span className="truncate text-xs text-muted-foreground">{codebase.name}{codebase.source ? ` — ${codebase.source}` : ""}</span>
              </button>
            ))}
            {matches.length === 0 && <div className="p-3 text-center text-sm text-muted-foreground">No matching codebases found</div>}
          </div>
        </div>
      )}

      {!disabled && (
        <div className="mt-1.5">
          <button type="button" onClick={() => setCreateOpen(!createOpen)} className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
            {createOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            Create a codebase
          </button>
          {createOpen && (
            <div className="mt-2 rounded-md border bg-muted/30 p-3">
              <CodebaseCreateForm
                compact
                onCreated={(created) => {
                  setCreateOpen(false);
                  // Seed the cache so the new codebase resolves on the next
                  // render, before the refetch lands — otherwise the selection
                  // briefly falls back to a raw-spec chip (and may flicker).
                  queryClient.setQueryData<CodebaseDocument[]>(["codebases"], (old) => {
                    if (!old) return [created];
                    return old.some((c) => c._id === created._id) ? old : [created, ...old];
                  });
                  queryClient.invalidateQueries({ queryKey: ["codebases"] });
                  // Archive codebases come with their first revision; select it
                  // directly so the picker has a concrete, valid revision spec
                  // instead of waiting on the revisions query.
                  onChange(created.firstRevision?.ref ?? created.slug);
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CodebaseIcon({ codebase }: { codebase: CodebaseDocument }) {
  return codebase.sourceType === "git"
    ? <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    : <FileArchive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

function shortSha(value?: string): string | undefined {
  return value ? value.slice(0, 7) : undefined;
}
