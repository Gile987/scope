// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useCallback, type Key } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useOutlet, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Insight } from "@/types";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Lightbulb, Trash2, ThumbsUp, ThumbsDown, ShieldBan, ShieldCheck } from "lucide-react";
import { truncate, formatDate } from "@/lib/utils";
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
  { id: "title", label: "Title", required: true },
  { id: "category", label: "Category" },
  { id: "source", label: "Source" },
  { id: "refs", label: "Refs" },
  { id: "created", label: "Created" },
  { id: "actions", label: "Actions" },
];

export function InsightsList() {
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const detailOutlet = useOutlet();
  const { id: activeId } = useParams<{ id?: string }>();
  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });
  const visibility = useHiddenColumns({ storageKey: "insights" });

  // Multi-selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const { data: insights = [], isLoading } = useQuery({
    queryKey: ["insights", state.search],
    queryFn: () => api.listInsights(state.search || undefined),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteInsight,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["insights"] }),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.deleteInsight(id)));
      const failed = results.filter((r) => r.status === "rejected").length;
      return { deleted: ids.length - failed, failed };
    },
    onSuccess: ({ deleted, failed }) => {
      toast.success(`Deleted ${deleted} insight${deleted !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const upvoteMutation = useMutation({
    mutationFn: api.upvoteInsight,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["insights"] }),
  });

  const downvoteMutation = useMutation({
    mutationFn: api.downvoteInsight,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["insights"] }),
  });

  const blockMutation = useMutation({
    mutationFn: (args: { id: string; blocked: boolean }) =>
      args.blocked ? api.blockInsight(args.id) : api.unblockInsight(args.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["insights"] }),
  });

  const sortedInsights = useMemo(() => {
    if (!state.sort) return insights;
    const sorted = [...insights];
    sorted.sort((a, b) => {
      const av = sortKey(a, state.sort!);
      const bv = sortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") sorted.reverse();
    return sorted;
  }, [insights, state.sort, state.sortDir]);

  const total = sortedInsights.length;
  const pageStart = (state.page - 1) * state.pageSize;
  const pageItems = sortedInsights.slice(pageStart, pageStart + state.pageSize);

  // Selection helpers
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

  const columns: DataTableColumn<Insight>[] = [
    {
      id: "title",
      header: "Title",
      sortable: true,
      hidden: visibility.isHidden("title"),
      cell: (insight) => (
        <div className={insight.blocked ? "opacity-50" : ""}>
          <span className="text-sm font-medium">{truncate(insight.title, 80)}</span>
          {insight.tags && insight.tags.length > 0 && (
            <div className="flex gap-1 mt-1">
              {insight.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="outline" className="text-xs">
                  {tag}
                </Badge>
              ))}
              {insight.tags.length > 3 && (
                <span className="text-xs text-muted-foreground">+{insight.tags.length - 3}</span>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      id: "category",
      header: "Category",
      width: "120px",
      hidden: visibility.isHidden("category"),
      cell: (insight) =>
        insight.category ? (
          <Badge variant="secondary" className="text-xs">
            {insight.category}
          </Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      id: "source",
      header: "Source",
      width: "100px",
      hidden: visibility.isHidden("source"),
      cell: (insight) => (
        <span className="text-xs text-muted-foreground">
          {insight.createdBy === "agent" ? "Agent" : "User"}
        </span>
      ),
    },
    {
      id: "refs",
      header: "Refs",
      width: "80px",
      align: "right",
      hidden: visibility.isHidden("refs"),
      cell: (insight) => (
        <span className="text-sm">{insight.referenceCount}</span>
      ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      width: "160px",
      hidden: visibility.isHidden("created"),
      cell: (insight) => (
        <span className="text-xs text-muted-foreground">{formatDate(insight.createdAt)}</span>
      ),
    },
    {
      id: "votes",
      header: "Votes",
      width: "160px",
      align: "right",
      cell: (insight) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => { e.stopPropagation(); upvoteMutation.mutate(insight._id); }}
            disabled={upvoteMutation.isPending}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs tabular-nums min-w-[2rem] text-center">
            {insight.upvotes - insight.downvotes}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => { e.stopPropagation(); downvoteMutation.mutate(insight._id); }}
            disabled={downvoteMutation.isPending}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => { e.stopPropagation(); blockMutation.mutate({ id: insight._id, blocked: !insight.blocked }); }}
            title={insight.blocked ? "Unblock" : "Block"}
          >
            {insight.blocked ? (
              <ShieldBan className="h-3.5 w-3.5 text-destructive" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </Button>
        </div>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "60px",
      align: "right",
      hidden: visibility.isHidden("actions"),
      cell: (insight) => (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={(e) => e.stopPropagation()}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent onClick={(e) => e.stopPropagation()}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete insight?</AlertDialogTitle>
              <AlertDialogDescription>
                This will soft-delete the insight. It can be recovered later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteMutation.mutate(insight._id)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ),
    },
  ];

  return (
    <ListLayout
      title="Insights"
      description="Cross-cutting observations discovered during report analysis"
      railStorageKey="insights"
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search insights..."
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
        navigate({ pathname: "/insights", search: window.location.search })
      }
    >
      <div className="flex flex-col gap-3">
        <BulkActionBar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          itemLabel="insight"
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
          getRowId={(insight) => insight._id}
          activeId={activeId}
          onRowClick={(insight) =>
            navigate({ pathname: `/insights/${insight._id}/preview`, search: window.location.search })
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
            state.search ? (
              "No insights match your search"
            ) : (
              <div className="text-center py-8">
                <Lightbulb className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                <h3 className="text-lg font-medium">No insights yet</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Insights are discovered by the report agent during analysis, or created manually by users.
                </p>
              </div>
            )
          }
        />
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={total}
          onPageChange={state.setPage}
          onPageSizeChange={state.setPageSize}
          itemLabel="insights"
        />
      </div>

      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} insight{selectedIds.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This soft-deletes the selected insights. They can be recovered later.
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

function sortKey(a: Insight, col: string): string | number {
  switch (col) {
    case "title":
      return a.title.toLowerCase();
    case "created":
      return new Date(a.createdAt).getTime();
    default:
      return "";
  }
}
