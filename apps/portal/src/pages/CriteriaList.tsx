// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useCallback, type Key } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useOutlet, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { CriteriaDocument } from "@/types";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Eye, GitBranch } from "lucide-react";
import { truncate } from "@/lib/utils";
import {
  ListLayout,
  FilterRail,
  ClearFiltersLink,
  CustomizeColumnsLink,
  CustomizeColumnsPanel,
  DataTable,
  Pagination,
  BulkActionBar,
  useHiddenColumns,
  useListUrlState,
  type DataTableColumn,
  type CustomizeColumnsOption,
} from "@/components/list-layout";

const FILTER_KEYS = [] as const;

const COLUMN_OPTIONS: CustomizeColumnsOption[] = [
  { id: "id", label: "ID", required: true },
  { id: "prompt", label: "Prompt" },
  { id: "dependencies", label: "Dependencies" },
  { id: "actions", label: "Actions" },
];

export function CriteriaList() {
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detailOutlet = useOutlet();
  const { id: activeId } = useParams<{ id?: string }>();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const visibility = useHiddenColumns({ storageKey: "criteria" });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const { data: criteria = [], isLoading } = useQuery({
    queryKey: ["criteria", state.search],
    queryFn: () => api.listCriteria(state.search || undefined),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteCriterion,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["criteria"] }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.deleteCriterion(id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      return { deleted: ids.length - failed, failed };
    },
    onSuccess: ({ deleted, failed }) => {
      toast.success(
        `Deleted ${deleted} criterion${deleted !== 1 ? "s" : ""}${failed ? `, ${failed} failed (likely has dependents)` : ""}`,
      );
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["criteria"] });
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const sortedCriteria = useMemo(() => {
    if (!state.sort) return criteria;
    const sorted = [...criteria];
    sorted.sort((a, b) => {
      const av = sortKey(a, state.sort!);
      const bv = sortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [criteria, state.sort, state.sortDir]);

  const total = sortedCriteria.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedCriteria.slice(pageStart, pageStart + state.pageSize);

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

  const columns: DataTableColumn<CriteriaDocument>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "200px",
      hidden: visibility.isHidden("id"),
      cell: (c) => (
        <span className="font-mono text-sm font-medium">{c.id}</span>
      ),
    },
    {
      id: "prompt",
      header: "Prompt",
      hidden: visibility.isHidden("prompt"),
      cell: (c) => (
        <span className="text-sm text-muted-foreground">{truncate(c.prompt, 100)}</span>
      ),
    },
    {
      id: "dependencies",
      header: "Dependencies",
      width: "200px",
      hidden: visibility.isHidden("dependencies"),
      cell: (c) => (
        <div className="flex flex-wrap gap-1">
          {(c.dependsOn ?? []).map((dep) => (
            <Badge key={dep} variant="secondary" className="text-xs font-mono">
              {dep}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "80px",
      align: "right",
      hidden: visibility.isHidden("actions"),
      cell: (c) => (
        <div className="flex items-center gap-1 justify-end">
          <Link to={`/criteria/${c.id}`} onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Eye className="h-4 w-4" />
            </Button>
          </Link>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive"
                onClick={(e) => e.stopPropagation()}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent onClick={(e) => e.stopPropagation()}>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete criterion?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete <strong>{c.id}</strong>. Criteria with dependents cannot be deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate(c.id)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ),
    },
  ];

  return (
    <ListLayout
      title="Criteria"
      description="Manage evaluation criteria and their dependencies"
      railStorageKey="criteria"
      actions={
        <>
          <Link to="/criteria/graph">
            <Button variant="outline" className="gap-1.5">
              <GitBranch className="h-4 w-4" /> Graph
            </Button>
          </Link>
          <Link to="/criteria/new">
            <Button className="gap-1.5">
              <Plus className="h-4 w-4" /> New Criterion
            </Button>
          </Link>
        </>
      }
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search criteria..."
          footer={
            <>
              <ClearFiltersLink
                onClick={state.clearFilters}
                disabled={!state.hasActiveFilters}
              />
              <CustomizeColumnsLink onClick={() => setCustomizeOpen((v) => !v)} />
            </>
          }
        >
          {null}
        </FilterRail>
      }
      secondaryPanel={
        customizeOpen ? (
          <CustomizeColumnsPanel
            columns={COLUMN_OPTIONS}
            hidden={visibility.hidden}
            onToggle={visibility.toggle}
            onSetHidden={visibility.setHidden}
            onReset={visibility.reset}
            onClose={() => setCustomizeOpen(false)}
          />
        ) : undefined
      }
      onSecondaryClose={() => setCustomizeOpen(false)}
      detail={detailOutlet}
      onDetailClose={() =>
        navigate({ pathname: "/criteria", search: window.location.search })
      }
    >
      <div className="flex flex-col gap-3">
        <BulkActionBar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          itemLabel="criterion"
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
          getRowId={(c) => c.id}
          activeId={activeId}
          onRowClick={(c) =>
            navigate({ pathname: `/criteria/${c.id}/preview`, search: window.location.search })
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
            state.search ? "No criteria match your search" : "No criteria defined yet"
          }
        />
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={total}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
          itemLabel="criteria"
        />
      </div>

      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} criterion{selectedIds.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected criteria. Criteria with dependents
              will be skipped.
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
  );
}

function sortKey(a: CriteriaDocument, col: string): string | number {
  switch (col) {
    case "id":
      return a.id.toLowerCase();
    default:
      return "";
  }
}
