// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useCallback, type Key } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useOutlet, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { ExtensionDocument } from "@/types";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Trash2, Puzzle, Download } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { ExtensionPicker } from "@/components/ExtensionPicker";
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

const FILTER_KEYS = ["origin"] as const;

const COLUMN_DEFS: CustomizeColumnsOption[] = [
  { id: "id", label: "ID", required: true },
  { id: "name", label: "Name" },
  { id: "publisher", label: "Publisher" },
  { id: "origin", label: "Origin" },
  { id: "created", label: "Created" },
  { id: "actions", label: "Actions" },
];

export function ExtensionList() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detailOutlet = useOutlet();
  const { id: activeId } = useParams<{ id?: string }>();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const columnVisibility = useHiddenColumns({ storageKey: "extensions" });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const { data: extensions = [], isLoading } = useQuery({
    queryKey: ["extensions"],
    queryFn: () => api.listExtensions(),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteExtension,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["extensions"] });
      toast.success("Extension deleted");
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.deleteExtension(id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      return { deleted: ids.length - failed, failed };
    },
    onSuccess: ({ deleted, failed }) => {
      toast.success(`Deleted ${deleted} extension${deleted !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["extensions"] });
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const activeExtensions = useMemo(
    () => extensions.filter((e: ExtensionDocument) => !e.deletedAt),
    [extensions],
  );

  const originOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of activeExtensions) map.set(e.origin, (map.get(e.origin) ?? 0) + 1);
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value, count }));
  }, [activeExtensions]);

  const filteredExtensions = useMemo(() => {
    const origins = state.getFilterList("origin");
    const q = state.search.trim().toLowerCase();
    return activeExtensions.filter((e) => {
      if (origins.length > 0 && !origins.includes(e.origin)) return false;
      if (q) {
        const blob = `${e._id} ${e.name} ${e.publisher}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [activeExtensions, state]);

  const sortedExtensions = useMemo(() => {
    if (!state.sort) return filteredExtensions;
    const sorted = [...filteredExtensions];
    sorted.sort((a, b) => {
      const av = extSortKey(a, state.sort!);
      const bv = extSortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [filteredExtensions, state.sort, state.sortDir]);

  const total = sortedExtensions.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedExtensions.slice(pageStart, pageStart + state.pageSize);

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

  const columns: DataTableColumn<ExtensionDocument>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "200px",
      cell: (e) => (
        <span className="flex items-center gap-1.5 font-mono text-xs">
          <Puzzle className="h-3.5 w-3.5 text-muted-foreground" />
          {e._id}
        </span>
      ),
    },
    ...(!columnVisibility.isHidden("name") ? [{
      id: "name",
      header: "Name",
      sortable: true,
      cell: (e: ExtensionDocument) => <span className="text-sm">{e.name}</span>,
    }] : []),
    ...(!columnVisibility.isHidden("publisher") ? [{
      id: "publisher",
      header: "Publisher",
      width: "160px",
      cell: (e: ExtensionDocument) => (
        <span className="font-mono text-xs text-muted-foreground">{e.publisher}</span>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("origin") ? [{
      id: "origin",
      header: "Origin",
      width: "120px",
      cell: (e: ExtensionDocument) => (
        <Badge variant="outline" className="text-xs">{e.origin}</Badge>
      ),
    }] : []),
    ...(!columnVisibility.isHidden("created") ? [{
      id: "created",
      header: "Created",
      sortable: true,
      width: "160px",
      cell: (e: ExtensionDocument) => (
        <span className="text-xs text-muted-foreground">{formatDate(e.createdAt)}</span>
      ),
    }] : []),
    {
      id: "actions",
      header: "",
      width: "60px",
      align: "right" as const,
      cell: (e) => (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive"
              onClick={(ev) => ev.stopPropagation()}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent onClick={(ev) => ev.stopPropagation()}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete extension?</AlertDialogTitle>
              <AlertDialogDescription>
                This soft-deletes &quot;{e.name}&quot;. It will no longer be available for new runs.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteMutation.mutate(e._id)}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ),
    },
  ];

  return (
    <>
      <ListLayout
        title="Extensions"
        description="Manage VS Code extensions installed in worker environments"
        railStorageKey="extensions"
        actions={
          <Button className="gap-1.5" onClick={() => setImportOpen(true)}>
            <Download className="h-4 w-4" /> Import Extension
          </Button>
        }
        filterRail={
          <FilterRail
            search={state.search}
            onSearchChange={state.setSearch}
            searchPlaceholder="Search extensions…"
            footer={
              <div className="flex items-center justify-between gap-2">
                <ClearFiltersLink
                  onClick={state.clearFilters}
                  disabled={!state.hasActiveFilters}
                />
                <CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} />
              </div>
            }
          >
            <FilterSection title="Origin" storageKey="extensions-origin">
              <CheckboxFilterGroup
                options={originOptions}
                selected={state.getFilterList("origin")}
                onToggle={(v) => state.toggleFilterValue("origin", v)}
              />
            </FilterSection>
          </FilterRail>
        }
        secondaryPanel={
          customizeOpen ? (
            <CustomizeColumnsPanel
              columns={COLUMN_DEFS}
              hidden={columnVisibility.hidden}
              onToggle={columnVisibility.toggle}
              onSetHidden={columnVisibility.setHidden}
              onReset={columnVisibility.reset}
              onClose={() => setCustomizeOpen(false)}
            />
          ) : undefined
        }
        onSecondaryClose={() => setCustomizeOpen(false)}
        detail={detailOutlet}
        onDetailClose={() =>
          navigate({ pathname: "/extensions", search: window.location.search })
        }
      >
        <div className="flex flex-col gap-3">
          <BulkActionBar
            count={selectedIds.size}
            onClear={() => setSelectedIds(new Set())}
            itemLabel="extension"
          >
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              disabled={bulkDeleteMutation.isPending || selectedIds.size === 0}
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </BulkActionBar>

          <DataTable
            items={pageItems}
            columns={columns}
            getRowId={(e) => e._id}
            activeId={activeId}
            onRowClick={(e) =>
              navigate({ pathname: `/extensions/${e._id}/preview`, search: window.location.search })
            }
            selection={{
              selectedIds,
              onToggle: toggleRow,
              onToggleAll: toggleAll,
            }}
            sort={state.sort}
            sortDir={state.sortDir}
            onSortChange={state.toggleSort}
            loading={isLoading}
            loadingRows={state.pageSize}
            emptyState={
              state.hasActiveFilters
                ? "No extensions match your filters"
                : "No extensions imported yet. Click Import Extension to add one."
            }
          />
          <Pagination
            page={state.page}
            pageSize={state.pageSize}
            total={total}
            onPageChange={state.setPage}
            onPageSizeChange={state.setPageSize}
            itemLabel="extensions"
          />
        </div>

        <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {selectedIds.size} extension{selectedIds.size !== 1 ? "s" : ""}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This soft-deletes the selected extensions. They will no longer be available for new runs.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  setBulkDeleteOpen(false);
                  bulkDeleteMutation.mutate([...selectedIds]);
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ListLayout>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import Extension</DialogTitle>
          </DialogHeader>
          <ExtensionPicker selected={[]} onChange={() => {}} importOnly />
        </DialogContent>
      </Dialog>
    </>
  );
}

function extSortKey(e: ExtensionDocument, col: string): string | number {
  switch (col) {
    case "id": return e._id;
    case "name": return e.name.toLowerCase();
    case "created": return new Date(e.createdAt).getTime();
    default: return "";
  }
}
