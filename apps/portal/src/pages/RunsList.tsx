// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useEffect, useCallback, type Key, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useOutlet, useParams, useSearchParams } from "react-router-dom";
import { Plus, Trash2, Repeat, RotateCcw, Pause, Play } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge, OutcomeBadge } from "@/components/StatusBadge";
import {
  ListLayout,
  FilterRail,
  FilterSection,
  CheckboxFilterGroup,
  ClearFiltersLink,  DataTable,
  Pagination,
  BulkActionBar,
  CustomizeColumnsPanel,
  CustomizeColumnsLink,
  DateRangeFilter,
  useHiddenColumns,
  useListUrlState,
  type DataTableColumn,
  type CustomizeColumnsOption,
} from "@/components/list-layout";
import { useShiftModifier } from "@/hooks/useShiftModifier";
import { formatDate, formatId, formatDuration, truncate } from "@/lib/utils";
import { WORKER_TYPES, STATUS_LIST, OUTCOME_LIST } from "@/types";
import type { Run, RunStatus, RunOutcome } from "@/types";

const FILTER_KEYS = ["worker", "status", "outcome", "taskPromptId", "submissionId", "criteria", "model", "profile", "os", "priority", "version", "dateFrom", "dateTo", "groupBy"] as const;

/** Sentinel value used in multi-value filters to match rows missing the underlying field. */
const EMPTY_FILTER_VALUE = "__empty__";

/**
 * Helper for multi-value filter logic that supports the `EMPTY_FILTER_VALUE` sentinel.
 * Returns true if the row matches the current selection (either by explicit value or because
 * the row is missing the field and the sentinel is selected).
 */
function matchMultiValueFilter(selected: string[], rawValue: string | null | undefined): boolean {
  if (selected.length === 0) return true;
  const wantsEmpty = selected.includes(EMPTY_FILTER_VALUE);
  const explicit = selected.filter((v) => v !== EMPTY_FILTER_VALUE);
  if (!rawValue) return wantsEmpty;
  if (explicit.length === 0) return false; // only "(Unknown)" selected and row has a value
  return explicit.includes(rawValue);
}

/** Compact inline badges with overflow (+N) dropdown for dense table cells. */
function OverflowBadges({
  items,
  max = 1,
  renderItem,
  renderMenuItem,
}: {
  items: string[];
  max?: number;
  renderItem: (item: string) => ReactNode;
  renderMenuItem: (item: string) => ReactNode;
}) {
  const visible = items.slice(0, max);
  const hidden = items.slice(max);
  return (
    <div className="flex min-w-0 items-center gap-1">
      {visible.map((item) => renderItem(item))}
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-xs font-mono bg-muted hover:bg-accent transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              +{hidden.length}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
            {hidden.map((item) => renderMenuItem(item))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

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
    defaultHidden: [
      "submission",
      "criteria",
      "version",
      "os",
      "mcp",
      "skills",
      "extensions",
      "profile",
      "priority",
      "model",
      "report",
      "attempt",
      "turns",
      "llmCalls",
      "tokens",
    ],
  });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  
  // Get groupBy from URL state
  const groupBy = (state.getFilter("groupBy") ?? "none") as "none" | "profile" | "task" | "submissionId";

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
        model: state.getFilterList("model"),
        profile: state.getFilterList("profile"),
        os: state.getFilterList("os"),
        priority: state.getFilterList("priority"),
        version: state.getFilterList("version"),
        dateFrom: state.getFilter("dateFrom"),
        dateTo: state.getFilter("dateTo"),
        groupBy: state.getFilter("groupBy"),
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
  const models = state.getFilterList("model");
  const profiles = state.getFilterList("profile");
  const osList = state.getFilterList("os");
  const priorities = state.getFilterList("priority");
  const versions = state.getFilterList("version");
  const taskPromptId = state.getFilter("taskPromptId") ?? undefined;
  const submissionId = state.getFilter("submissionId") ?? undefined;
  const criteria = state.getFilter("criteria") ?? undefined;
  const dateFrom = state.getFilter("dateFrom");
  const dateTo = state.getFilter("dateTo");

  const currentCursor = cursorStack[state.page - 1];

  // The server only accepts a single explicit value per filter; if multiple values
  // are selected or the special `(Unknown)` sentinel is selected, we fetch the
  // broader set and filter client-side.
  const singleServerValue = (vals: string[]): string | undefined =>
    vals.length === 1 && vals[0] !== EMPTY_FILTER_VALUE ? vals[0] : undefined;
  const serverWorker = singleServerValue(workers);
  const serverStatus = singleServerValue(statuses);
  const serverOutcome = singleServerValue(outcomes);
  const serverProfile = singleServerValue(profiles);

  const { data: runsResponse, isLoading, isRefetching } = useQuery({
    queryKey: ["runs", serverWorker, serverStatus, serverOutcome, taskPromptId, submissionId, criteria, serverProfile, state.pageSize, currentCursor],
    queryFn: () =>
      api.listRuns({
        worker: serverWorker,
        status: serverStatus,
        outcome: serverOutcome,
        taskPromptId,
        submissionId,
        criteria,
        profileId: serverProfile,
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
      // Run client-side filter for worker/status/outcome whenever the server-side
      // filter can't fully express the selection (multi-value or `(Unknown)`).
      if (workers.length > 0 && !serverWorker && !matchMultiValueFilter(workers, r.workerType)) return false;
      if (statuses.length > 0 && !serverStatus && !matchMultiValueFilter(statuses, r.run?.status)) return false;
      if (outcomes.length > 0 && !serverOutcome && !matchMultiValueFilter(outcomes, r.run?.outcome)) return false;
      // Profile is also server-narrowed when a single non-sentinel is selected.
      if (profiles.length > 0 && !serverProfile && !matchMultiValueFilter(profiles, r.profileId)) return false;
      if (!matchMultiValueFilter(models, r.model)) return false;
      if (!matchMultiValueFilter(osList, r.run?.os?.platform)) return false;
      if (!matchMultiValueFilter(priorities, r.priority != null ? String(r.priority) : null)) return false;
      if (!matchMultiValueFilter(versions, r.agentVersion)) return false;
      if (dateFrom || dateTo) {
        const ts = r.createdAt ? new Date(r.createdAt).getTime() : NaN;
        if (Number.isNaN(ts)) return false;
        if (dateFrom) {
          const fromTs = Date.parse(`${dateFrom}T00:00:00`);
          if (!Number.isNaN(fromTs) && ts < fromTs) return false;
        }
        if (dateTo) {
          const toTs = Date.parse(`${dateTo}T00:00:00`);
          if (!Number.isNaN(toTs) && ts >= toTs + 86_400_000) return false;
        }
      }
      if (q) {
        const hay =
          (r._id + " " + (r.scenario?.task ?? "") + " " + (r.model ?? "") + " " + (r.workerType ?? "")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allRuns, workers, statuses, outcomes, models, profiles, osList, priorities, versions, dateFrom, dateTo, serverWorker, serverStatus, serverOutcome, serverProfile, state.search]);

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

  // Group runs by the selected groupBy option
  const groupedAndDisplayedRuns = useMemo(() => {
    if (groupBy === "none") return sortedRuns;
    
    const groups = new Map<string, Run[]>();
    for (const run of sortedRuns) {
      let key = "";
      switch (groupBy) {
        case "profile":
          key = run.profileId ?? "(No Profile)";
          break;
        case "task":
          key = run.scenario?.task ?? "(No Task)";
          break;
        case "submissionId":
          key = run.submissionId ?? "(No Submission)";
          break;
      }
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(run);
    }
    return Array.from(groups.entries()).map(([groupKey, runs]) => ({
      groupKey,
      runs,
    }));
  }, [sortedRuns, groupBy]);

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
  const workerOptions = useMemo(() => {
    const opts = WORKER_TYPES.map((w) => ({
      value: w as string,
      label: w as string,
      count: allRuns.filter((r) => r.workerType === w).length,
    }));
    const emptyCount = allRuns.filter((r) => !r.workerType).length;
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const statusOptions = useMemo(() => {
    const opts = STATUS_LIST.map((s) => ({
      value: s as string,
      label: s as string,
      count: allRuns.filter((r) => r.run?.status === s).length,
    }));
    const emptyCount = allRuns.filter((r) => !r.run?.status).length;
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const outcomeOptions = useMemo(() => {
    const opts = OUTCOME_LIST.map((o) => ({
      value: o as string,
      label: o as string,
      count: allRuns.filter((r) => r.run?.outcome === o).length,
    }));
    const emptyCount = allRuns.filter((r) => !r.run?.outcome).length;
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const modelOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let emptyCount = 0;
    for (const r of allRuns) {
      if (r.model) counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
      else emptyCount += 1;
    }
    const opts = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value, count }));
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const profileOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let emptyCount = 0;
    for (const r of allRuns) {
      if (r.profileId) counts.set(r.profileId, (counts.get(r.profileId) ?? 0) + 1);
      else emptyCount += 1;
    }
    const opts = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: formatId(value), count }));
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const osOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let emptyCount = 0;
    for (const r of allRuns) {
      const p = r.run?.os?.platform;
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
      else emptyCount += 1;
    }
    const opts = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value, count }));
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const priorityOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let emptyCount = 0;
    for (const r of allRuns) {
      if (r.priority != null) {
        const k = String(r.priority);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      } else {
        emptyCount += 1;
      }
    }
    const opts = [...counts.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([value, count]) => ({ value, label: value, count }));
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  const versionOptions = useMemo(() => {
    const counts = new Map<string, number>();
    let emptyCount = 0;
    for (const r of allRuns) {
      if (r.agentVersion) counts.set(r.agentVersion, (counts.get(r.agentVersion) ?? 0) + 1);
      else emptyCount += 1;
    }
    const opts = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, count]) => ({ value, label: value, count }));
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns]);

  // Lazy: only fetch report summary when the "report" column is visible.
  const reportColumnVisible = !columnVisibility.isHidden("report");
  const visibleIds = useMemo(
    () => (reportColumnVisible ? allRuns.map((r) => r._id) : []),
    [reportColumnVisible, allRuns],
  );
  const { data: reportSummary } = useQuery({
    queryKey: ["runs-report-summary", visibleIds],
    queryFn: () => api.bulkReportSummary(visibleIds),
    enabled: reportColumnVisible && visibleIds.length > 0,
    staleTime: 10_000,
  });

  const columnOptions: CustomizeColumnsOption[] = [
    { id: "id", label: "ID", required: true },
    { id: "submission", label: "Submission" },
    { id: "task", label: "Task" },
    { id: "criteria", label: "Criteria" },
    { id: "worker", label: "Worker" },
    { id: "version", label: "Version" },
    { id: "os", label: "OS" },
    { id: "mcp", label: "MCP" },
    { id: "skills", label: "Skills" },
    { id: "extensions", label: "Extensions" },
    { id: "profile", label: "Profile" },
    { id: "priority", label: "Priority" },
    { id: "model", label: "Model" },
    { id: "status", label: "Status" },
    { id: "outcome", label: "Outcome" },
    { id: "report", label: "Report" },
    { id: "attempt", label: "Attempt" },
    { id: "turns", label: "Turns" },
    { id: "llmCalls", label: "LLM Calls" },
    { id: "duration", label: "Duration" },
    { id: "tokens", label: "Tokens" },
    { id: "created", label: "Created" },
  ];

  const columns: DataTableColumn<Run>[] = [
    {
      id: "id",
      header: "ID",
      sortable: true,
      width: "120px",
      sticky: "left",
      stickyOffset: "40px",
      cell: (r) => <span className="font-mono text-xs">{formatId(r._id)}</span>,
    },
    {
      id: "submission",
      header: "Submission",
      width: "120px",
      hidden: columnVisibility.isHidden("submission"),
      cell: (r) =>
        r.submissionId ? (
          <span className="font-mono text-xs">{formatId(r.submissionId)}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "task",
      header: "Task",
      hidden: columnVisibility.isHidden("task"),
      cell: (r) =>
        r.scenario?.task ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm cursor-default">{truncate(r.scenario.task, 60)}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-pre-wrap text-xs">
              {r.scenario.task}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "criteria",
      header: "Criteria",
      width: "180px",
      hidden: columnVisibility.isHidden("criteria"),
      cell: (r) => {
        const criteria = r.scenario?.criteria ?? [];
        return criteria.length > 0 ? (
          <OverflowBadges
            items={criteria}
            max={1}
            renderItem={(criterionId) => (
              <Tooltip key={criterionId}>
                <TooltipTrigger asChild>
                  <Link
                    to={`/criteria/${criterionId}`}
                    className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {criterionId}
                  </Link>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{criterionId}</TooltipContent>
              </Tooltip>
            )}
            renderMenuItem={(criterionId) => (
              <DropdownMenuItem key={criterionId} asChild>
                <Link
                  to={`/criteria/${criterionId}`}
                  className="font-mono text-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  {criterionId}
                </Link>
              </DropdownMenuItem>
            )}
          />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "worker",
      header: "Worker",
      sortable: true,
      width: "180px",
      hidden: columnVisibility.isHidden("worker"),
      cell: (r) => (
        <div className="max-w-[170px] min-w-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="max-w-[120px] min-w-0 font-mono text-xs cursor-default">
                <span className="block min-w-0 truncate">{truncate(r.workerType, 14)}</span>
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="text-xs">{r.workerType}</TooltipContent>
          </Tooltip>
          {r.model && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="mt-0.5 block max-w-[120px] truncate font-mono text-xs text-muted-foreground cursor-default">
                  {truncate(r.model, 14)}
                </span>
              </TooltipTrigger>
              <TooltipContent className="text-xs">{r.model}</TooltipContent>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      id: "version",
      header: "Version",
      width: "110px",
      hidden: columnVisibility.isHidden("version"),
      cell: (r) =>
        r.agentVersion ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-xs truncate block cursor-default">{r.agentVersion}</span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">{r.agentVersion}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "os",
      header: "OS",
      width: "120px",
      hidden: columnVisibility.isHidden("os"),
      cell: (r) => {
        const os = r.run?.os;
        return os ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-xs cursor-default">{os.platform}/{os.arch}</span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              {os.platform} {os.release} ({os.arch})
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "mcp",
      header: "MCP",
      width: "180px",
      hidden: columnVisibility.isHidden("mcp"),
      cell: (r) => {
        const servers = r.mcpServers ?? [];
        return servers.length > 0 ? (
          <OverflowBadges
            items={servers}
            max={1}
            renderItem={(slug) => (
              <Tooltip key={slug}>
                <TooltipTrigger asChild>
                  <Link
                    to={`/mcp-servers/${slug}`}
                    className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {slug}
                  </Link>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{slug}</TooltipContent>
              </Tooltip>
            )}
            renderMenuItem={(slug) => (
              <DropdownMenuItem key={slug} asChild>
                <Link
                  to={`/mcp-servers/${slug}`}
                  className="font-mono text-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  {slug}
                </Link>
              </DropdownMenuItem>
            )}
          />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "skills",
      header: "Skills",
      width: "180px",
      hidden: columnVisibility.isHidden("skills"),
      cell: (r) => {
        const refs = (r.skillRevisions ?? r.skills ?? []) as string[];
        return refs.length > 0 ? (
          <OverflowBadges
            items={refs}
            max={1}
            renderItem={(ref) => {
              const skillName = ref.split("@")[0].split("/").pop() ?? ref;
              const skillSlug = ref.split("@")[0];
              return (
                <Tooltip key={ref}>
                  <TooltipTrigger asChild>
                    <Link
                      to={`/skills/${skillSlug}`}
                      className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {truncate(skillName, 20)}
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">{ref}</TooltipContent>
                </Tooltip>
              );
            }}
            renderMenuItem={(ref) => {
              const skillName = ref.split("@")[0].split("/").pop() ?? ref;
              const skillSlug = ref.split("@")[0];
              return (
                <DropdownMenuItem key={ref} asChild>
                  <Link
                    to={`/skills/${skillSlug}`}
                    className="font-mono text-xs"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {skillName}
                  </Link>
                </DropdownMenuItem>
              );
            }}
          />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "extensions",
      header: "Extensions",
      width: "190px",
      hidden: columnVisibility.isHidden("extensions"),
      cell: (r) => {
        const ids = r.extensions ?? [];
        return ids.length > 0 ? (
          <OverflowBadges
            items={ids}
            max={1}
            renderItem={(id) => {
              const [qualifiedName, version] = id.split("@");
              const shortName = qualifiedName.split(".").pop() ?? id;
              const extensionLabel = `${shortName}${version ? `@${version}` : ""}`;
              return (
                <Tooltip key={id}>
                  <TooltipTrigger asChild>
                    <Link
                      to={`/extensions/${qualifiedName}`}
                      className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {truncate(extensionLabel, 20)}
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">{id}</TooltipContent>
                </Tooltip>
              );
            }}
            renderMenuItem={(id) => {
              const [qualifiedName, version] = id.split("@");
              const shortName = qualifiedName.split(".").pop() ?? id;
              const extensionLabel = `${shortName}${version ? `@${version}` : ""}`;
              return (
                <DropdownMenuItem key={id} asChild>
                  <Link
                    to={`/extensions/${qualifiedName}`}
                    className="font-mono text-xs"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {truncate(extensionLabel, 20)}
                  </Link>
                </DropdownMenuItem>
              );
            }}
          />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "profile",
      header: "Profile",
      width: "140px",
      hidden: columnVisibility.isHidden("profile"),
      cell: (r) =>
        r.profileId ? (
          <span className="font-mono text-xs">{formatId(r.profileId)}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "priority",
      header: "Priority",
      sortable: true,
      width: "80px",
      hidden: columnVisibility.isHidden("priority"),
      cell: (r) =>
        r.priority != null ? (
          <span className="font-mono text-xs">{r.priority}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "model",
      header: "Model",
      width: "180px",
      hidden: columnVisibility.isHidden("model"),
      cell: (r) =>
        r.model ? (
          <Tooltip>
            <TooltipTrigger asChild>
            <span className="font-mono text-xs truncate block max-w-[120px] cursor-default">{r.model}</span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">{r.model}</TooltipContent>
          </Tooltip>
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
      id: "report",
      header: "Report",
      width: "120px",
      hidden: columnVisibility.isHidden("report"),
      cell: (r) => {
        const s = reportSummary?.[r._id];
        if (!s || s.total === 0) return <span className="text-xs text-muted-foreground">—</span>;
        if (s.failed > 0) return <Badge variant="destructive" className="text-xs">{s.failed} failed</Badge>;
        if (s.generating > 0) return <Badge variant="secondary" className="text-xs">generating</Badge>;
        if (s.pending > 0) return <Badge variant="outline" className="text-xs">{s.pending} pending</Badge>;
        if (s.completed > 0) return <Badge variant="default" className="text-xs">{s.completed} done</Badge>;
        return <span className="text-xs text-muted-foreground">—</span>;
      },
    },
    {
      id: "attempt",
      header: "Attempt",
      width: "80px",
      hidden: columnVisibility.isHidden("attempt"),
      cell: (r) => {
        const n = r.run?.attemptNumber;
        return n != null ? (
          <span className="font-mono text-xs">#{n}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "turns",
      header: "Turns",
      width: "70px",
      hidden: columnVisibility.isHidden("turns"),
      cell: (r) => {
        const n = r.run?.turns?.length ?? 0;
        return n > 0 ? (
          <span className="text-xs">{n}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "llmCalls",
      header: "LLM Calls",
      width: "90px",
      hidden: columnVisibility.isHidden("llmCalls"),
      cell: (r) => {
        const n = r.run?.aiCallCount;
        return n != null && n > 0 ? (
          <span className="text-xs">{n}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
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
      id: "tokens",
      header: "Tokens",
      width: "100px",
      hidden: columnVisibility.isHidden("tokens"),
      cell: (r) => {
        const t = r.run?.tokenUsage?.totalTokens;
        return t != null && t > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-xs cursor-default">{t.toLocaleString()}</span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              prompt {r.run?.tokenUsage?.promptTokens ?? 0} / completion {r.run?.tokenUsage?.completionTokens ?? 0}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
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
    {
      id: "actions",
      header: "",
      width: "100px",
      sticky: "right",
      cell: (r) => (
        <div className="flex items-center justify-end gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Re-run identical"
            disabled={bulkResubmitMutation.isPending}
            onClick={(e) => {
              e.stopPropagation();
              bulkResubmitMutation.mutate([r._id]);
            }}
          >
            <Repeat className="h-3.5 w-3.5" />
            <span className="sr-only">Re-run</span>
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                title="Delete run"
                disabled={bulkDeleteMutation.isPending}
                onClick={(e) => e.stopPropagation()}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="sr-only">Delete</span>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent onClick={(e) => e.stopPropagation()}>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete run?</AlertDialogTitle>
                <AlertDialogDescription>
                  This soft-deletes run <span className="font-mono">{formatId(r._id)}</span>. Iterations and logs are retained but the run will be hidden from listings.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={(e) => {
                    e.stopPropagation();
                    bulkDeleteMutation.mutate([r._id]);
                  }}
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
    <TooltipProvider delayDuration={200}>
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
          <FilterSection title="Created" storageKey="runs-created">
            <DateRangeFilter
              from={dateFrom}
              to={dateTo}
              onChange={(f, t) => {
                state.setFilter("dateFrom", f);
                state.setFilter("dateTo", t);
              }}
            />
          </FilterSection>
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
          {modelOptions.length > 0 && (
            <FilterSection title="Model" storageKey="runs-model" defaultOpen={false}>
              <CheckboxFilterGroup
                options={modelOptions}
                selected={models}
                onToggle={(v) => state.toggleFilterValue("model", v)}
              />
            </FilterSection>
          )}
          {profileOptions.length > 0 && (
            <FilterSection title="Profile" storageKey="runs-profile" defaultOpen={false}>
              <CheckboxFilterGroup
                options={profileOptions}
                selected={profiles}
                onToggle={(v) => state.toggleFilterValue("profile", v)}
              />
            </FilterSection>
          )}
          {versionOptions.length > 0 && (
            <FilterSection title="Version" storageKey="runs-version" defaultOpen={false}>
              <CheckboxFilterGroup
                options={versionOptions}
                selected={versions}
                onToggle={(v) => state.toggleFilterValue("version", v)}
              />
            </FilterSection>
          )}
          {osOptions.length > 0 && (
            <FilterSection title="OS" storageKey="runs-os" defaultOpen={false}>
              <CheckboxFilterGroup
                options={osOptions}
                selected={osList}
                onToggle={(v) => state.toggleFilterValue("os", v)}
              />
            </FilterSection>
          )}
          {priorityOptions.length > 0 && (
            <FilterSection title="Priority" storageKey="runs-priority" defaultOpen={false}>
              <CheckboxFilterGroup
                options={priorityOptions}
                selected={priorities}
                onToggle={(v) => state.toggleFilterValue("priority", v)}
              />
            </FilterSection>
          )}
          <FilterSection title="Group By" storageKey="runs-groupby" defaultOpen={false}>
            <div className="space-y-2 px-3 py-2">
              {[
                { value: "none", label: "None" },
                { value: "profile", label: "Profile" },
                { value: "task", label: "Task" },
                { value: "submissionId", label: "Submission ID" },
              ].map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="groupBy"
                    value={opt.value}
                    checked={groupBy === opt.value}
                    onChange={(e) => state.setFilter("groupBy", e.target.value)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <span className="text-sm">{opt.label}</span>
                </label>
              ))}
            </div>
          </FilterSection>
        </FilterRail>
      }
      detail={detailOutlet}
      onDetailClose={() =>
        navigate({ pathname: "/runs", search: window.location.search })
      }
      secondaryPanel={
        customizeOpen ? (
          <CustomizeColumnsPanel
            columns={columnOptions}
            hidden={columnVisibility.hidden}
            onToggle={columnVisibility.toggle}
            onSetHidden={columnVisibility.setHidden}
            onReset={columnVisibility.reset}
            onClose={() => setCustomizeOpen(false)}
          />
        ) : null
      }
      onSecondaryClose={() => setCustomizeOpen(false)}
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

        {groupBy === "none" ? (
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
        ) : (
          <div className="space-y-4">
            {(groupedAndDisplayedRuns as Array<{ groupKey: string; runs: Run[] }>).map(({ groupKey, runs }) => (
              <div key={groupKey} className="rounded-lg border border-border/50 overflow-hidden">
                <div className="bg-muted/30 px-4 py-3 font-semibold text-sm flex items-center justify-between">
                  <span>{groupKey}</span>
                  <span className="text-xs text-muted-foreground font-normal">{runs.length} run{runs.length !== 1 ? "s" : ""}</span>
                </div>
                <DataTable
                  items={runs}
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
                  emptyState=""
                />
              </div>
            ))}
            {(groupedAndDisplayedRuns as Array<{ groupKey: string; runs: Run[] }>).length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                {state.hasActiveFilters
                  ? "No runs match the current filters."
                  : "No runs yet. Submit one with the New Run button."}
              </div>
            )}
          </div>
        )}
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
    </TooltipProvider>
  );
}

function sortKey(r: Run, col: string): string | number {
  switch (col) {
    case "id":
      return r._id;
    case "worker":
      return r.workerType;
    case "priority":
      return r.priority ?? 0;
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
