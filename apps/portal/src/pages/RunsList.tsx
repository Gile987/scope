// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useEffect, useCallback, type Key } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useOutlet, useParams, useSearchParams } from "react-router-dom";
import { Plus, Trash2, Repeat, RotateCcw, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { StatusBadge, OutcomeBadge } from "@/components/StatusBadge";
import {
  ListLayout,
  FilterRail,
  FilterSection,
  CheckboxFilterGroup,
  ClearFiltersLink,
  DataTable,
  Pagination,
  BulkActionBar,
  CustomizeColumnsPanel,
  CustomizeColumnsLink,
  useHiddenColumns,
  useListUrlState,
  type DataTableColumn,
  type CustomizeColumnsOption,
} from "@/components/list-layout";
import { useShiftModifier } from "@/hooks/useShiftModifier";
import { formatDate, formatId, formatDuration, truncate } from "@/lib/utils";
import { WORKER_TYPES, STATUS_LIST, OUTCOME_LIST } from "@/types";
import type { Run, RunStatus, RunOutcome } from "@/types";

const FILTER_KEYS = ["worker", "status", "outcome", "taskPromptId", "submissionId", "criteria"] as const;

export function RunsList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detailOutlet = useOutlet();
  const { id: activeId } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const isForceRetryModifierActive = useShiftModifier();

  const state = useListUrlState({ defaultPageSize: 25, filterKeys: FILTER_KEYS });

  // Column visibility — persisted under scope:hidden-columns:runs.
  const columnVisibility = useHiddenColumns({
    storageKey: "runs",
    defaultHidden: ["model"],
  });
  const [customizeOpen, setCustomizeOpen] = useState(false);

  // Cursor pagination — keep a stack of cursors that map a virtual page number
  // to an `after` cursor (page 1 = no cursor, page 2 = stack[0], …).
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);

  // Multi-selection state — preserved while the user navigates pages.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Reset stack whenever filters or page size change.
  const filtersKey = useMemo(
    () =>
      JSON.stringify({
        search: state.search,
        worker: state.getFilterList("worker"),
        status: state.getFilterList("status"),
        outcome: state.getFilterList("outcome"),
        taskPromptId: state.getFilter("taskPromptId"),
        submissionId: state.getFilter("submissionId"),
        criteria: state.getFilter("criteria"),
        pageSize: state.pageSize,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.search,
      state.pageSize,
      searchParams.toString(),
    ],
  );
  useEffect(() => {
    setCursorStack([undefined]);
    setSelectedIds(new Set());
    if (state.page !== 1) state.setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  const workers = state.getFilterList("worker");
  const statuses = state.getFilterList("status");
  const outcomes = state.getFilterList("outcome");
  const taskPromptId = state.getFilter("taskPromptId") ?? undefined;
  const submissionId = state.getFilter("submissionId") ?? undefined;
  const criteria = state.getFilter("criteria") ?? undefined;

  const currentCursor = cursorStack[state.page - 1];

  // The server only accepts a single value per filter; if multiple are selected
  // we fetch the broader set and filter client-side.
  const serverWorker = workers.length === 1 ? workers[0] : undefined;
  const serverStatus = statuses.length === 1 ? statuses[0] : undefined;
  const serverOutcome = outcomes.length === 1 ? outcomes[0] : undefined;

  const { data: runsResponse, isLoading, isRefetching } = useQuery({
    queryKey: ["runs", serverWorker, serverStatus, serverOutcome, taskPromptId, submissionId, criteria, state.pageSize, currentCursor],
    queryFn: () =>
      api.listRuns({
        worker: serverWorker,
        status: serverStatus,
        outcome: serverOutcome,
        taskPromptId,
        submissionId,
        criteria,
        limit: state.pageSize,
        after: currentCursor,
      }),
    refetchInterval: 10_000,
  });

  const allRuns = runsResponse?.data ?? [];
  const cursors = runsResponse?.cursors ?? { next: null, prev: null };
  const estimatedTotal = runsResponse?.estimatedTotal;

  // Client-side filtering for multi-value selections + search.
  const filteredRuns = useMemo(() => {
    const q = state.search.trim().toLowerCase();
    return allRuns.filter((r) => {
      if (workers.length > 1 && !workers.includes(r.workerType)) return false;
      if (statuses.length > 1) {
        const s = r.run?.status;
        if (!s || !statuses.includes(s)) return false;
      }
      if (outcomes.length > 1) {
        const o = r.run?.outcome;
        if (!o || !outcomes.includes(o)) return false;
      }
      if (q) {
        const hay =
          (r._id + " " + (r.scenario?.task ?? "") + " " + (r.model ?? "") + " " + (r.workerType ?? "")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allRuns, workers, statuses, outcomes, state.search]);

  const sortedRuns = useMemo(() => {
    if (!state.sort) return filteredRuns;
    const out = [...filteredRuns];
    out.sort((a, b) => {
      const av = sortKey(a, state.sort!);
      const bv = sortKey(b, state.sort!);
      if (av < bv) return -1;
      if (av > bv) return 1;
      return 0;
    });
    if (state.sortDir === "desc") out.reverse();
    return out;
  }, [filteredRuns, state.sort, state.sortDir]);

  const handlePageChange = useCallback(
    (next: number) => {
      if (next === state.page) return;
      if (next === state.page + 1) {
        if (!cursors.next) return;
        setCursorStack((prev) => {
          const copy = [...prev];
          copy[next - 1] = cursors.next ?? undefined;
          return copy;
        });
        state.setPage(next);
      } else if (next === state.page - 1) {
        state.setPage(next);
      } else if (next === 1) {
        state.setPage(1);
      }
    },
    [state, cursors.next],
  );

  // ---- Bulk action mutations ----
  const invalidateRuns = () => queryClient.invalidateQueries({ queryKey: ["runs"] });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) => api.bulkDeleteRuns(ids),
    onSuccess: (res) => {
      toast.success(`Deleted ${res.deleted} run${res.deleted !== 1 ? "s" : ""}`);
      setSelectedIds(new Set());
      invalidateRuns();
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const bulkRetryMutation = useMutation({
    mutationFn: ({ ids, force }: { ids: string[]; force?: boolean }) =>
      api.bulkRetryRuns(ids, { force }),
    onSuccess: (res) => {
      toast.success(`Retried ${res.retried} run${res.retried !== 1 ? "s" : ""}${res.skipped ? `, skipped ${res.skipped}` : ""}`);
      setSelectedIds(new Set());
      invalidateRuns();
    },
    onError: (err: Error) => toast.error(`Failed to retry: ${err.message}`),
  });

  const bulkResubmitMutation = useMutation({
    mutationFn: (ids: string[]) => api.bulkResubmitRuns(ids, 1),
    onSuccess: (res) => {
      toast.success(`Resubmitted ${res.submitted} run${res.submitted !== 1 ? "s" : ""}${res.failed.length ? `, ${res.failed.length} failed` : ""}`);
      setSelectedIds(new Set());
      invalidateRuns();
    },
    onError: (err: Error) => toast.error(`Failed to resubmit: ${err.message}`),
  });

  const bulkPauseMutation = useMutation({
    mutationFn: (ids: string[]) => api.bulkPauseRuns(ids),
    onSuccess: (res) => {
      toast.success(`Paused ${res.paused} run${res.paused !== 1 ? "s" : ""}${res.skipped ? `, skipped ${res.skipped}` : ""}`);
      setSelectedIds(new Set());
      invalidateRuns();
    },
    onError: (err: Error) => toast.error(`Failed to pause: ${err.message}`),
  });

  const bulkResumeMutation = useMutation({
    mutationFn: (ids: string[]) => api.bulkResumeRuns(ids),
    onSuccess: (res) => {
      toast.success(`Resumed ${res.resumed} run${res.resumed !== 1 ? "s" : ""}${res.skipped ? `, skipped ${res.skipped}` : ""}`);
      setSelectedIds(new Set());
      invalidateRuns();
    },
    onError: (err: Error) => toast.error(`Failed to resume: ${err.message}`),
  });

  // ---- Selection helpers ----
  const toggleRowSelection = useCallback((id: Key) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const key = String(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAllSelection = useCallback((allIds: Key[]) => {
    setSelectedIds((prev) => {
      const stringIds = allIds.map((id) => String(id));
      const allSelected = stringIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) {
        for (const id of stringIds) next.delete(id);
      } else {
        for (const id of stringIds) next.add(id);
      }
      return next;
    });
  }, []);

  const selectedRunsList = useMemo(
    () => allRuns.filter((r) => selectedIds.has(r._id)),
    [allRuns, selectedIds],
  );

  // Capability counts so action buttons can disable cleanly.
  const selectionCaps = useMemo(() => {
    let retryable = 0;
    let pausable = 0;
    let resumable = 0;
    for (const r of selectedRunsList) {
      const s = r.run?.status;
      if (s === "done") retryable += 1;
      if (s === "pending" || s === "queued" || s === "processing") pausable += 1;
      if (s === "paused") resumable += 1;
    }
    return { retryable, pausable, resumable };
  }, [selectedRunsList]);

  const isBusy =
    bulkDeleteMutation.isPending ||
    bulkRetryMutation.isPending ||
    bulkResubmitMutation.isPending ||
    bulkPauseMutation.isPending ||
    bulkResumeMutation.isPending;

  const handleBulkRetry = useCallback(() => {
    if (selectedIds.size === 0) return;
    bulkRetryMutation.mutate({ ids: [...selectedIds], force: isForceRetryModifierActive });
  }, [bulkRetryMutation, selectedIds, isForceRetryModifierActive]);

  const handleBulkResubmit = useCallback(() => {
    if (selectedIds.size === 0) return;
    bulkResubmitMutation.mutate([...selectedIds]);
  }, [bulkResubmitMutation, selectedIds]);

  const handleBulkPause = useCallback(() => {
    if (selectionCaps.pausable === 0) return;
    bulkPauseMutation.mutate([...selectedIds]);
  }, [bulkPauseMutation, selectedIds, selectionCaps.pausable]);

  const handleBulkResume = useCallback(() => {
    if (selectionCaps.resumable === 0) return;
    bulkResumeMutation.mutate([...selectedIds]);
  }, [bulkResumeMutation, selectedIds, selectionCaps.resumable]);

  // Filter options derived from current page (counts reflect this page only).
  const workerOptions = useMemo(
    () =>
      WORKER_TYPES.map((w) => ({
        value: w,
        label: w,
        count: allRuns.filter((r) => r.workerType === w).length,
      })),
    [allRuns],
  );

  const statusOptions = useMemo(
    () =>
      STATUS_LIST.map((s) => ({
        value: s,
        label: s,
        count: allRuns.filter((r) => r.run?.status === s).length,
      })),
    [allRuns],
  );

  const outcomeOptions = useMemo(
    () =>
      OUTCOME_LIST.map((o) => ({
        value: o,
        label: o,
        count: allRuns.filter((r) => r.run?.outcome === o).length,
      })),
    [allRuns],
  );

  const columnOptions: CustomizeColumnsOption[] = [
    { id: "id", label: "ID", required: true },
    { id: "task", label: "Task" },
    { id: "worker", label: "Worker" },
    { id: "model", label: "Model" },
    { id: "status", label: "Status" },
    { id: "outcome", label: "Outcome" },
    { id: "duration", label: "Duration" },
    { id: "created", label: "Created" },
  ];

  const columns: DataTableColumn<Run>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "120px",
      cell: (r) => <span className="font-mono text-xs">{formatId(r._id)}</span>,
    },
    {
      id: "task",
      header: "Task",
      hidden: columnVisibility.isHidden("task"),
      cell: (r) =>
        r.scenario?.task ? (
          <span className="text-sm" title={r.scenario.task}>
            {truncate(r.scenario.task, 60)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "worker",
      header: "Worker",
      sortable: true,
      width: "160px",
      hidden: columnVisibility.isHidden("worker"),
      cell: (r) => <Badge variant="outline" className="font-mono text-xs">{r.workerType}</Badge>,
    },
    {
      id: "model",
      header: "Model",
      width: "180px",
      hidden: columnVisibility.isHidden("model"),
      cell: (r) =>
        r.model ? (
          <span className="font-mono text-xs">{r.model}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "status",
      header: "Status",
      sortable: true,
      width: "120px",
      hidden: columnVisibility.isHidden("status"),
      cell: (r) => (r.run?.status ? <StatusBadge status={r.run.status} /> : <span className="text-xs text-muted-foreground">—</span>),
    },
    {
      id: "outcome",
      header: "Outcome",
      width: "120px",
      hidden: columnVisibility.isHidden("outcome"),
      cell: (r) => (r.run?.outcome ? <OutcomeBadge outcome={r.run.outcome} /> : <span className="text-xs text-muted-foreground">—</span>),
    },
    {
      id: "duration",
      header: "Duration",
      sortable: true,
      width: "100px",
      hidden: columnVisibility.isHidden("duration"),
      cell: (r) => {
        const start = r.run?.startedAt;
        const end = r.run?.finishedAt;
        if (!start || !end) return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <span className="font-mono text-xs">
            {formatDuration(new Date(end).getTime() - new Date(start).getTime())}
          </span>
        );
      },
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      width: "160px",
      hidden: columnVisibility.isHidden("created"),
      cell: (r) => <span className="text-xs text-muted-foreground">{formatDate(r.createdAt)}</span>,
    },
  ];

  return (
    <ListLayout
      title="Runs"
      description={
        estimatedTotal != null
          ? `~${estimatedTotal.toLocaleString()} runs total`
          : "Manage and monitor benchmark runs"
      }
      railStorageKey="runs"
      actions={
        <Link to="/runs/new">
          <Button size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" /> New Run
          </Button>
        </Link>
      }
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search runs…"
          refreshing={isRefetching}
          footer={
            <>
              <ClearFiltersLink onClick={state.clearFilters} disabled={!state.hasActiveFilters} />
              <CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} />
            </>
          }
        >
          <FilterSection title="Worker" storageKey="runs-worker">
            <CheckboxFilterGroup
              options={workerOptions}
              selected={workers}
              onToggle={(v) => state.toggleFilterValue("worker", v)}
            />
          </FilterSection>
          <FilterSection title="Status" storageKey="runs-status">
            <CheckboxFilterGroup
              options={statusOptions}
              selected={statuses}
              onToggle={(v) => state.toggleFilterValue("status", v)}
            />
          </FilterSection>
          <FilterSection title="Outcome" storageKey="runs-outcome">
            <CheckboxFilterGroup
              options={outcomeOptions}
              selected={outcomes}
              onToggle={(v) => state.toggleFilterValue("outcome", v)}
            />
          </FilterSection>
        </FilterRail>
      }
      detail={detailOutlet}
      secondaryPanel={
        customizeOpen ? (
          <CustomizeColumnsPanel
            columns={columnOptions}
            hidden={columnVisibility.hidden}
            onApply={columnVisibility.setHidden}
            onReset={columnVisibility.reset}
            onClose={() => setCustomizeOpen(false)}
          />
        ) : null
      }
    >
      <div className="flex flex-col gap-3">
        <BulkActionBar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          itemLabel="run"
        >
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isBusy || selectionCaps.pausable === 0}
            onClick={handleBulkPause}
            title="Pause pending/queued/processing runs"
          >
            <Pause className="h-3.5 w-3.5" /> Pause
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isBusy || selectionCaps.resumable === 0}
            onClick={handleBulkResume}
            title="Resume paused runs"
          >
            <Play className="h-3.5 w-3.5" /> Resume
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isBusy || selectionCaps.retryable === 0}
            onClick={handleBulkRetry}
            title={
              isForceRetryModifierActive
                ? "Force retry (ignore attempt limits)"
                : "Retry completed runs — hold Shift to force"
            }
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {isForceRetryModifierActive ? "Force Retry" : "Retry"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isBusy || selectedIds.size === 0}
            onClick={handleBulkResubmit}
            title="Resubmit selected runs as a new submission"
          >
            <Repeat className="h-3.5 w-3.5" /> Resubmit
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="gap-1.5"
            disabled={isBusy || selectedIds.size === 0}
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </BulkActionBar>

        <DataTable
          items={sortedRuns}
          columns={columns}
          getRowId={(r) => r._id}
          activeId={activeId}
          onRowClick={(r) => navigate({ pathname: `/runs/${r._id}/preview`, search: window.location.search })}
          selection={{
            selectedIds,
            onToggle: (id) => toggleRowSelection(id),
            onToggleAll: (ids) => toggleAllSelection(ids),
          }}
          sort={state.sort}
          sortDir={state.sortDir}
          onSortChange={state.toggleSort}
          loading={isLoading}
          emptyState={
            state.hasActiveFilters
              ? "No runs match the current filters."
              : "No runs yet. Submit one with the New Run button."
          }
        />
        <Pagination
          page={state.page}
          pageSize={state.pageSize}
          total={estimatedTotal}
          onPageChange={handlePageChange}
          onPageSizeChange={state.setPageSize}
          hasNext={!!cursors.next}
          hasPrev={state.page > 1}
          hideFirstLast
          itemLabel="runs"
        />
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.size} run{selectedIds.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected runs along with their logs,
              turns, and report associations. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setDeleteDialogOpen(false);
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

function sortKey(r: Run, col: string): string | number {
  switch (col) {
    case "id":
      return r._id;
    case "worker":
      return r.workerType;
    case "status":
      return r.run?.status ?? "";
    case "duration": {
      const start = r.run?.startedAt;
      const end = r.run?.finishedAt;
      if (!start || !end) return 0;
      return new Date(end).getTime() - new Date(start).getTime();
    }
    case "created":
      return new Date(r.createdAt).getTime();
    default:
      return "";
  }
}

// Suppress unused warnings for re-exported types kept for callers.
export type { RunStatus, RunOutcome };
