// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useCallback, type Key } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { CodebaseDocument } from "@/types";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Trash2, FolderGit2, Plus } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { CodebaseCreateForm } from "@/components/CodebaseCreateForm";
import { CodebasePreviewPanel } from "./CodebasePreviewPanel";
import {
  ListLayout,
  FilterRail,
  FilterSection,
  CheckboxFilterGroup,
  ClearFiltersLink,
  CustomizeColumnsPanel,
  CustomizeColumnsLink,
  DataTable,
  Pagination,
  BulkActionBar,
  useHiddenColumns,
  useListUrlState,
  type DataTableColumn,
  type CustomizeColumnsOption,
} from "@/components/list-layout";
import { HelpTooltip } from "@/components/HelpTooltip";

const FILTER_KEYS = ["sourceType"] as const;

const COLUMN_DEFS: CustomizeColumnsOption[] = [
  { id: "slug", label: "Slug", required: true },
  { id: "name", label: "Name" },
  { id: "sourceType", label: "Type" },
  { id: "source", label: "Source" },
  { id: "latest", label: "Latest" },
  { id: "created", label: "Created" },
  { id: "actions", label: "Actions" },
];

export function CodebaseList() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const previewId = searchParams.get("preview");
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const columnVisibility = useHiddenColumns({ storageKey: "codebases" });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const { data: codebases = [], isLoading } = useQuery({ queryKey: ["codebases"], queryFn: () => api.listCodebases() });

  const deleteMutation = useMutation({
    mutationFn: api.deleteCodebase,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["codebases"] });
      toast.success("Codebase deleted");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to delete codebase"),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.deleteCodebase(id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      return { deleted: ids.length - failed, failed };
    },
    onSuccess: ({ deleted, failed }) => {
      toast.success(`Deleted ${deleted} codebase${deleted !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["codebases"] });
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const activeCodebases = useMemo(() => codebases.filter((c: CodebaseDocument) => !c.deletedAt), [codebases]);

  const typeOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of activeCodebases) map.set(c.sourceType, (map.get(c.sourceType) ?? 0) + 1);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ value, label: value, count }));
  }, [activeCodebases]);

  const filteredCodebases = useMemo(() => {
    const sourceTypes = state.getFilterList("sourceType");
    const q = state.search.trim().toLowerCase();
    return activeCodebases.filter((c) => {
      if (sourceTypes.length > 0 && !sourceTypes.includes(c.sourceType)) return false;
      if (q) {
        const blob = `${c._id} ${c.slug} ${c.name} ${c.source ?? ""} ${c.description ?? ""}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [activeCodebases, state]);

  const sortedCodebases = useMemo(() => {
    if (!state.sort) return filteredCodebases;
    const sorted = [...filteredCodebases];
    sorted.sort((a, b) => {
      const av = codebaseSortKey(a, state.sort!);
      const bv = codebaseSortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [filteredCodebases, state.sort, state.sortDir]);

  const total = sortedCodebases.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedCodebases.slice(pageStart, pageStart + state.pageSize);

  const toggleRow = useCallback((id: Key) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const toggleAll = useCallback((ids: Key[]) => {
    setSelectedIds((prev) => {
      const stringIds = ids.map((id) => String(id));
      const allSelected = stringIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) for (const id of stringIds) next.delete(id);
      else for (const id of stringIds) next.add(id);
      return next;
    });
  }, []);

  const navigateToPreview = useCallback((id: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("preview", id);
    navigate({ pathname: "/codebases", search: `?${params.toString()}` });
  }, [navigate]);

  const closePreview = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete("preview");
    const search = params.toString();
    navigate({ pathname: "/codebases", search: search ? `?${search}` : "" });
  }, [navigate]);

  const columns: DataTableColumn<CodebaseDocument>[] = [
    {
      id: "slug",
      header: "Slug",
      sortable: true,
      width: "200px",
      cell: (c) => <span className="flex items-center gap-1.5 font-mono text-xs"><FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />{c.slug}</span>,
    },
    ...(!columnVisibility.isHidden("name") ? [{ id: "name", header: "Name", sortable: true, cell: (c: CodebaseDocument) => <span className="text-sm">{c.name}</span> }] : []),
    ...(!columnVisibility.isHidden("sourceType") ? [{ id: "sourceType", header: "Type", width: "120px", cell: (c: CodebaseDocument) => <Badge variant="outline" className="text-xs">{c.sourceType}</Badge> }] : []),
    ...(!columnVisibility.isHidden("source") ? [{ id: "source", header: "Source", cell: (c: CodebaseDocument) => <span className="font-mono text-xs text-muted-foreground">{c.source ?? "—"}</span> }] : []),
    ...(!columnVisibility.isHidden("latest") ? [{ id: "latest", header: "Latest", width: "120px", cell: (c: CodebaseDocument) => <span className="font-mono text-xs text-muted-foreground">{c.revisionCounter > 0 ? `${c.slug}@r${c.revisionCounter}` : "—"}</span> }] : []),
    ...(!columnVisibility.isHidden("created") ? [{ id: "created", header: "Created", sortable: true, width: "160px", cell: (c: CodebaseDocument) => <span className="text-xs text-muted-foreground">{formatDate(c.createdAt)}</span> }] : []),
    {
      id: "actions",
      header: "",
      width: "60px",
      align: "right" as const,
      cell: (c) => (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={(ev) => ev.stopPropagation()}><Trash2 className="h-4 w-4" /></Button>
          </AlertDialogTrigger>
          <AlertDialogContent onClick={(ev) => ev.stopPropagation()}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete codebase?</AlertDialogTitle>
              <AlertDialogDescription>This soft-deletes the codebase &quot;{c.name}&quot;. Existing runs keep their resolved revision.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteMutation.mutate(c._id)}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ),
    },
  ];

  return (
    <>
      <ListLayout
        title={<span className="inline-flex items-center gap-1.5">Codebases<HelpTooltip text="Reusable workspace seeds attached to runs as immutable revisions." size="md" /></span>}
        description="Manage git repositories and archive snapshots used to seed agent workspaces"
        railStorageKey="codebases"
        actions={<Button className="gap-1.5" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> Create Codebase</Button>}
        filterRail={
          <FilterRail search={state.search} onSearchChange={state.setSearch} searchPlaceholder="Search codebases…" footer={<div className="flex items-center justify-between gap-2"><ClearFiltersLink onClick={state.clearFilters} disabled={!state.hasActiveFilters} /><CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} /></div>}>
            <FilterSection title="Source type" storageKey="codebases-source-type">
              <CheckboxFilterGroup options={typeOptions} selected={state.getFilterList("sourceType")} onToggle={(v) => state.toggleFilterValue("sourceType", v)} />
            </FilterSection>
          </FilterRail>
        }
        secondaryPanel={customizeOpen ? <CustomizeColumnsPanel columns={COLUMN_DEFS} hidden={columnVisibility.hidden} onToggle={columnVisibility.toggle} onSetHidden={columnVisibility.setHidden} onReset={columnVisibility.reset} onClose={() => setCustomizeOpen(false)} /> : undefined}
        onSecondaryClose={() => setCustomizeOpen(false)}
        detail={previewId ? <CodebasePreviewPanel id={previewId} /> : undefined}
        onDetailClose={closePreview}
      >
        <div className="flex flex-col gap-3">
          <BulkActionBar count={selectedIds.size} onClear={() => setSelectedIds(new Set())} itemLabel="codebase">
            <Button variant="destructive" size="sm" className="gap-1.5" disabled={bulkDeleteMutation.isPending || selectedIds.size === 0} onClick={() => setBulkDeleteOpen(true)}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
          </BulkActionBar>
          <DataTable
            items={pageItems}
            columns={columns}
            getRowId={(c) => c._id}
            activeId={previewId ?? undefined}
            onRowClick={(c) => navigateToPreview(c._id)}
            selection={{ selectedIds, onToggle: toggleRow, onToggleAll: toggleAll }}
            sort={state.sort}
            sortDir={state.sortDir}
            onSortChange={state.toggleSort}
            loading={isLoading}
            loadingRows={state.pageSize}
            emptyState={state.hasActiveFilters ? "No codebases match your filters" : "No codebases yet. Create one from a git repository or archive."}
          />
          <Pagination page={state.page} pageSize={state.pageSize} total={total} onPageChange={state.setPage} onPageSizeChange={state.setPageSize} itemLabel="codebases" />
        </div>

        <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {selectedIds.size} codebase{selectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
              <AlertDialogDescription>This soft-deletes the selected codebases. Existing runs keep their resolved revisions.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { setBulkDeleteOpen(false); bulkDeleteMutation.mutate([...selectedIds]); }}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ListLayout>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Create Codebase</DialogTitle></DialogHeader>
          <CodebaseCreateForm onCreated={(created) => { setCreateOpen(false); navigate(`/codebases/${created._id}`); }} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function codebaseSortKey(c: CodebaseDocument, col: string): string | number {
  switch (col) {
    case "slug": return c.slug;
    case "name": return c.name.toLowerCase();
    case "created": return new Date(c.createdAt).getTime();
    default: return "";
  }
}
