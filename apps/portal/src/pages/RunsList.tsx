// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState, useEffect, useCallback, type Key, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useOutlet, useParams, useSearchParams } from "react-router-dom";
import { Trash2, Repeat, RotateCcw, Pause, Play, ChevronDown, ChevronRight, Apple, AppWindow } from "lucide-react";
import { FaLinux } from "react-icons/fa";
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
  useColumnOrder,
  useListUrlState,
  usePersistentSort,
  initSortFromLocalStorage,
  type DataTableColumn,
  type CustomizeColumnsOption,
} from "@/components/list-layout";
import { useShiftModifier } from "@/hooks/useShiftModifier";
import { formatDate, formatId, formatDuration, truncate, cn } from "@/lib/utils";
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

/** Small OS-platform icon. Falls back to a text badge for unknown platforms. */
function OsPlatformIcon({ platform }: { platform: string }) {
  const p = platform.toLowerCase();
  const Icon = p === "darwin" || p === "macos"
    ? Apple
    : p === "win32" || p === "windows"
      ? AppWindow
      : p === "linux"
        ? FaLinux
        : null;
  const label = p === "darwin" || p === "macos"
    ? "macOS"
    : p === "win32" || p === "windows"
      ? "Windows"
      : p === "linux"
        ? "Linux"
        : platform;
  if (!Icon) {
    return (
      <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-mono">
        {platform}
      </Badge>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground">
          <Icon className="h-3.5 w-3.5" aria-label={label} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Aggregate progress bar used in grouped rows for the Status and Outcome
 * columns. Shows `count/total label` with a colored progress track.
 */
function AggregateProgress({
  count,
  failedCount = 0,
  total,
  label,
  tone,
}: {
  count: number;
  /** Optional failed count rendered as a red segment alongside the success segment. */
  failedCount?: number;
  total: number;
  label: string;
  tone: "success" | "destructive";
}) {
  if (total === 0) return <span className="text-xs text-muted-foreground">—</span>;
  const successPct = Math.round((count / total) * 100);
  const failedPct = Math.round((failedCount / total) * 100);
  const successClass = tone === "success" ? "bg-emerald-500" : "bg-destructive";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium">
        {count}/{total} {label}
      </span>
      <div className="flex h-1 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full transition-all", successClass)} style={{ width: `${successPct}%` }} />
        {failedPct > 0 && (
          <div className="h-full bg-destructive transition-all" style={{ width: `${failedPct}%` }} />
        )}
      </div>
    </div>
  );
}

// All toggleable columns rendered by the customize-columns panel and the
// DataTable. Lifted to module scope so its identity is stable across renders
// (used as a dependency by useColumnOrder via the column-id signature).
const COLUMN_OPTIONS: CustomizeColumnsOption[] = [
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
const COLUMN_IDS = COLUMN_OPTIONS.map((o) => o.id);

// Segmented toggle used in the list header for the Group By control. Kept
// inline because it is only used here.
const GROUP_BY_OPTIONS: ReadonlyArray<{ value: "profile" | "task" | "submissionId"; label: string }> = [
  { value: "profile", label: "Profile" },
  { value: "task", label: "Task" },
  { value: "submissionId", label: "Submission" },
];

function GroupByToggle({
  value,
  onChange,
}: {
  value: "none" | "profile" | "task" | "submissionId";
  onChange: (next: "none" | "profile" | "task" | "submissionId") => void;
}) {
  return (
    <div
      role="group"
      aria-label="Group runs by"
      className="hidden sm:inline-flex h-8 items-center rounded-md border border-border/60 bg-card p-0.5"
    >
      <span className="px-2 text-xs font-medium text-muted-foreground">Group by</span>
      {GROUP_BY_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? "none" : opt.value)}
            className={
              "h-7 rounded-sm px-2.5 text-xs font-medium transition-colors " +
              (active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")
            }
          >
            {opt.label}
          </button>
        );
      })}
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

  // Initialize sort preference from localStorage if no sort params in URL
  useEffect(() => {
    initSortFromLocalStorage(state, "runs");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist sort preference to localStorage
  usePersistentSort(state, { pageKey: "runs" });

  // Column visibility — persisted under scope:hidden-columns:runs:v2.
  // The `:v2` suffix forces the new default set to apply for users who had
  // an older preference stored under the unversioned key.
  // Default visible: ID, Submission, Task, Criteria, Worker, Version, OS, MCP,
  // Skills, Extensions, Profile, Priority, Status, Outcome.
  // Hidden by default (opt-in via Customize columns): Model, Report, Attempt,
  // Turns, LLM Calls, Duration, Tokens, Created.
  const columnVisibility = useHiddenColumns({
    storageKey: "runs:v2",
    defaultHidden: [
      "model",
      "report",
      "attempt",
      "turns",
      "llmCalls",
      "duration",
      "tokens",
      "created",
    ],
  });
  // Persisted column order (matches the customize panel). The `id` column is
  // marked `required` in COLUMN_OPTIONS and is locked from reordering by the
  // panel; `actions` lives outside COLUMN_OPTIONS and is always pinned right.
  const columnOrder = useColumnOrder({
    storageKey: "runs:v2",
    columnIds: COLUMN_IDS,
  });
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(new Set());
  
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

  useEffect(() => {
    setExpandedGroupKeys(new Set());
  }, [groupBy, filtersKey, state.page]);

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
  const { data: profilesData } = useQuery({
    queryKey: ["profiles", "runs-list-grouping"],
    queryFn: () => api.listProfiles(),
    staleTime: 60_000,
  });

  const allRuns = runsResponse?.data ?? [];
  const cursors = runsResponse?.cursors ?? { next: null, prev: null };
  const estimatedTotal = runsResponse?.estimatedTotal;
  const profileNameById = useMemo(
    () => new Map((profilesData ?? []).map((profile) => [profile._id, profile.name])),
    [profilesData],
  );

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
  const groupedRuns = useMemo(
    () => (groupBy === "none" ? [] : (groupedAndDisplayedRuns as Array<{ groupKey: string; runs: Run[] }>)),
    [groupBy, groupedAndDisplayedRuns],
  );
  const groupedTableItems = useMemo(
    () => groupedRuns.flatMap(({ runs }) => runs),
    [groupedRuns],
  );

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

  const toggleGroupExpansion = useCallback((groupKey: string) => {
    setExpandedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
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
      .map(([value, count]) => ({ value, label: profileNameById.get(value) ?? formatId(value), count }));
    if (emptyCount > 0) opts.push({ value: EMPTY_FILTER_VALUE, label: "(Unknown)", count: emptyCount });
    return opts;
  }, [allRuns, profileNameById]);

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
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="max-w-[160px] min-w-0 font-mono text-xs cursor-default">
              <span className="block min-w-0 truncate">{truncate(r.workerType, 18)}</span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="text-xs">{r.workerType}</TooltipContent>
        </Tooltip>
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
        if (!os) return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1.5 cursor-default">
                <OsPlatformIcon platform={os.platform} />
                <span className="font-mono text-xs text-muted-foreground">{os.arch}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              {os.platform} {os.release} ({os.arch})
            </TooltipContent>
          </Tooltip>
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
      width: "220px",
      hidden: columnVisibility.isHidden("profile"),
      cell: (r) => {
        if (!r.profileId) return <span className="text-xs text-muted-foreground">—</span>;

        const profileLabel = profileNameById.get(r.profileId) ?? formatId(r.profileId);

        return (
          <div className="flex min-w-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block min-w-0 truncate text-xs font-medium cursor-default">{profileLabel}</span>
              </TooltipTrigger>
              <TooltipContent className="text-xs">{profileLabel}</TooltipContent>
            </Tooltip>
          </div>
        );
      },
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

  // Apply persisted column order. The `id` column is pinned to the left
  // (sticky) and `actions` is pinned to the right; everything in between is
  // sorted by the order from `useColumnOrder`. Unknown ids land at the end of
  // their bucket, which is harmless because the order hook reconciles new ids
  // into the persisted list automatically.
  const orderedColumns: DataTableColumn<Run>[] = (() => {
    const orderIndex = new Map<string, number>();
    columnOrder.order.forEach((id, idx) => orderIndex.set(id, idx));
    const idCol = columns.find((c) => c.id === "id");
    const actionsCol = columns.find((c) => c.id === "actions");
    const middle = columns
      .filter((c) => c.id !== "id" && c.id !== "actions")
      .sort((a, b) => {
        const ai = orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bi = orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
    return [
      ...(idCol ? [idCol] : []),
      ...middle,
      ...(actionsCol ? [actionsCol] : []),
    ];
  })();

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
        <GroupByToggle
          value={groupBy}
          onChange={(next) => state.setFilter("groupBy", next === "none" ? null : next)}
        />
      }
      filterRail={
        <FilterRail
          search={state.search}
          onSearchChange={state.setSearch}
          searchPlaceholder="Search runs…"
          refreshing={isRefetching}
          sortablePageKey="runs"
          defaultSectionOrder={["created", "worker", "status", "outcome", "model", "profile", "version", "os", "priority", "groupby"]}
          footer={
            <>
              <ClearFiltersLink onClick={state.clearFilters} disabled={!state.hasActiveFilters} />
              <CustomizeColumnsLink onClick={() => setCustomizeOpen(true)} />
            </>
          }
        >
          <FilterSection title="Created" storageKey="runs-created" sortableId="created">
            <DateRangeFilter
              from={dateFrom}
              to={dateTo}
              onChange={(f, t) => {
                state.setFilter("dateFrom", f);
                state.setFilter("dateTo", t);
              }}
            />
          </FilterSection>
          <FilterSection title="Worker" storageKey="runs-worker" sortableId="worker">
            <CheckboxFilterGroup
              options={workerOptions}
              selected={workers}
              onToggle={(v) => state.toggleFilterValue("worker", v)}
            />
          </FilterSection>
          <FilterSection title="Status" storageKey="runs-status" sortableId="status">
            <CheckboxFilterGroup
              options={statusOptions}
              selected={statuses}
              onToggle={(v) => state.toggleFilterValue("status", v)}
            />
          </FilterSection>
          <FilterSection title="Outcome" storageKey="runs-outcome" sortableId="outcome">
            <CheckboxFilterGroup
              options={outcomeOptions}
              selected={outcomes}
              onToggle={(v) => state.toggleFilterValue("outcome", v)}
            />
          </FilterSection>
          {modelOptions.length > 0 && (
            <FilterSection title="Model" storageKey="runs-model" defaultOpen={false} sortableId="model">
              <CheckboxFilterGroup
                options={modelOptions}
                selected={models}
                onToggle={(v) => state.toggleFilterValue("model", v)}
              />
            </FilterSection>
          )}
          {profileOptions.length > 0 && (
            <FilterSection title="Profile" storageKey="runs-profile" defaultOpen={false} sortableId="profile">
              <CheckboxFilterGroup
                options={profileOptions}
                selected={profiles}
                onToggle={(v) => state.toggleFilterValue("profile", v)}
              />
            </FilterSection>
          )}
          {versionOptions.length > 0 && (
            <FilterSection title="Version" storageKey="runs-version" defaultOpen={false} sortableId="version">
              <CheckboxFilterGroup
                options={versionOptions}
                selected={versions}
                onToggle={(v) => state.toggleFilterValue("version", v)}
              />
            </FilterSection>
          )}
          {osOptions.length > 0 && (
            <FilterSection title="OS" storageKey="runs-os" defaultOpen={false} sortableId="os">
              <CheckboxFilterGroup
                options={osOptions}
                selected={osList}
                onToggle={(v) => state.toggleFilterValue("os", v)}
              />
            </FilterSection>
          )}
          {priorityOptions.length > 0 && (
            <FilterSection title="Priority" storageKey="runs-priority" defaultOpen={false} sortableId="priority">
              <CheckboxFilterGroup
                options={priorityOptions}
                selected={priorities}
                onToggle={(v) => state.toggleFilterValue("priority", v)}
              />
            </FilterSection>
          )}
        </FilterRail>
      }
      detail={detailOutlet}
      onDetailClose={() =>
        navigate({ pathname: "/runs", search: window.location.search })
      }
      secondaryPanel={
        customizeOpen ? (
          <CustomizeColumnsPanel
            columns={COLUMN_OPTIONS}
            hidden={columnVisibility.hidden}
            onToggle={columnVisibility.toggle}
            onSetHidden={columnVisibility.setHidden}
            onReset={() => {
              columnVisibility.reset();
              columnOrder.reset();
            }}
            onClose={() => setCustomizeOpen(false)}
            order={columnOrder.order}
            onReorder={columnOrder.setOrder}
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
            columns={orderedColumns}
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
            <DataTable
              items={groupedTableItems}
              columns={orderedColumns}
              getRowId={(r) => r._id}
              activeId={activeId}
              onRowClick={(r) => navigate({ pathname: `/runs/${r._id}/preview`, search: window.location.search })}
              selection={{
                selectedIds,
                onToggle: (id) => toggleRowSelection(id),
                onToggleAll: (ids) => toggleAllSelection(ids),
              }}
              grouping={{
                getGroupKey: (run) => {
                  switch (groupBy) {
                    case "profile":
                      return run.profileId ?? "(No Profile)";
                    case "task":
                      return run.scenario?.task ?? "(No Task)";
                    case "submissionId":
                      return run.submissionId ?? "(No Submission)";
                    default:
                      return "";
                  }
                },
                expandedGroupKeys,
                onToggleGroup: toggleGroupExpansion,
                renderGroupCell: (column, runs, expanded) => {
                  const total = runs.length;
                  if (column.id === "id") {
                    return (
                      <div className="flex items-center gap-1.5">
                        {expanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <span className="text-xs font-semibold">
                          {total} run{total !== 1 ? "s" : ""}
                        </span>
                      </div>
                    );
                  }
                  if (column.id === "status") {
                    const doneCount = runs.filter((r) => r.run?.status === "done").length;
                    // A run is considered "failed" at the status level when it
                    // reached the terminal `done` state with a non-succeeded outcome.
                    const failedAtStatus = runs.filter(
                      (r) => r.run?.status === "done" && r.run?.outcome === "failed",
                    ).length;
                    return (
                      <AggregateProgress
                        count={doneCount - failedAtStatus}
                        failedCount={failedAtStatus}
                        total={total}
                        label="done"
                        tone={failedAtStatus > 0 && doneCount === failedAtStatus ? "destructive" : "success"}
                      />
                    );
                  }
                  if (column.id === "outcome") {
                    const passCount = runs.filter((r) => r.run?.outcome === "succeeded").length;
                    const failedCount = runs.filter((r) => r.run?.outcome === "failed").length;
                    return (
                      <AggregateProgress
                        count={passCount}
                        failedCount={failedCount}
                        total={total}
                        label="pass"
                        tone={failedCount > 0 && passCount === 0 ? "destructive" : "success"}
                      />
                    );
                  }
                  if (column.id === "os") {
                    const platforms = Array.from(
                      new Set(
                        runs
                          .map((r) => r.run?.os?.platform)
                          .filter((p): p is string => !!p),
                      ),
                    ).sort();
                    if (platforms.length === 0) {
                      return <span className="text-xs text-muted-foreground">—</span>;
                    }
                    return (
                      <div className="flex items-center gap-1">
                        {platforms.map((platform) => (
                          <OsPlatformIcon key={platform} platform={platform} />
                        ))}
                      </div>
                    );
                  }
                  if (column.id === "profile" && groupBy === "profile") {
                    const groupKey = runs[0]?.profileId ?? "(No Profile)";
                    const profileLabel =
                      groupKey !== "(No Profile)"
                        ? (profileNameById.get(groupKey) ?? formatId(groupKey))
                        : "—";
                    return (
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block min-w-0 truncate text-xs font-medium cursor-default">
                              {profileLabel}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">{profileLabel}</TooltipContent>
                        </Tooltip>
                      </div>
                    );
                  }

                  // Distinct-value aggregate: for identifier/categorical columns,
                  // render the single shared value via the row cell when uniform;
                  // otherwise show "N distinct" with a tooltip listing the values.
                  const distinct = (
                    label: string,
                    getKey: (r: Run) => string | null | undefined,
                    renderSingle?: (r: Run) => ReactNode,
                  ): ReactNode => {
                    const values = Array.from(
                      new Set(
                        runs
                          .map(getKey)
                          .filter((v): v is string => v != null && v !== ""),
                      ),
                    );
                    if (values.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                    if (values.length === 1) {
                      const first = runs.find((r) => getKey(r) === values[0]) ?? runs[0];
                      return renderSingle ? renderSingle(first) : column.cell(first);
                    }
                    return (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs font-medium text-muted-foreground cursor-default">
                            {values.length} {label}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs max-w-xs">
                          <div className="flex flex-col gap-0.5 font-mono">
                            {values.slice(0, 10).map((v) => (
                              <span key={v}>{v}</span>
                            ))}
                            {values.length > 10 && <span>… +{values.length - 10} more</span>}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    );
                  };

                  // Union aggregate: merge all unique items across runs into a single
                  // representation rendered through the first run's cell. We swap the
                  // run's value with the union so the existing badges/links keep working.
                  const numericSum = (getN: (r: Run) => number | null | undefined): ReactNode => {
                    const values = runs.map(getN).filter((n): n is number => n != null);
                    if (values.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                    const sum = values.reduce((a, b) => a + b, 0);
                    return (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="font-mono text-xs cursor-default">{sum.toLocaleString()}</span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          Σ across {values.length} run{values.length !== 1 ? "s" : ""}
                        </TooltipContent>
                      </Tooltip>
                    );
                  };

                  switch (column.id) {
                    case "submission":
                      return distinct("submissions", (r) => r.submissionId);
                    case "task":
                      return distinct("tasks", (r) => r.scenario?.task);
                    case "worker":
                      return distinct("workers", (r) => r.workerType);
                    case "version":
                      return distinct("versions", (r) => r.agentVersion);
                    case "model":
                      return distinct("models", (r) => r.model);

                    case "criteria": {
                      const union = Array.from(
                        new Set(runs.flatMap((r) => r.scenario?.criteria ?? [])),
                      );
                      if (union.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const synthetic = { ...runs[0], scenario: { ...runs[0].scenario, criteria: union } } as Run;
                      return column.cell(synthetic);
                    }
                    case "mcp": {
                      const union = Array.from(
                        new Set(runs.flatMap((r) => r.mcpServers ?? [])),
                      );
                      if (union.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const synthetic = { ...runs[0], mcpServers: union } as Run;
                      return column.cell(synthetic);
                    }
                    case "skills": {
                      const union = Array.from(
                        new Set(runs.flatMap((r) => (r.skillRevisions ?? r.skills ?? []) as string[])),
                      );
                      if (union.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const synthetic = { ...runs[0], skillRevisions: union, skills: union } as Run;
                      return column.cell(synthetic);
                    }
                    case "extensions": {
                      const union = Array.from(
                        new Set(runs.flatMap((r) => r.extensions ?? [])),
                      );
                      if (union.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const synthetic = { ...runs[0], extensions: union } as Run;
                      return column.cell(synthetic);
                    }

                    case "priority": {
                      const values = runs
                        .map((r) => r.priority)
                        .filter((p): p is number => p != null);
                      if (values.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const min = Math.min(...values);
                      const max = Math.max(...values);
                      return (
                        <span className="font-mono text-xs">
                          {min === max ? min : `${min}–${max}`}
                        </span>
                      );
                    }

                    case "attempt": {
                      const values = runs
                        .map((r) => r.run?.attemptNumber)
                        .filter((n): n is number => n != null);
                      if (values.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      return (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="font-mono text-xs cursor-default">#{Math.max(...values)}</span>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">max attempt across group</TooltipContent>
                        </Tooltip>
                      );
                    }

                    case "turns":
                      return numericSum((r) => r.run?.turns?.length);
                    case "llmCalls":
                      return numericSum((r) => r.run?.aiCallCount);
                    case "tokens":
                      return numericSum((r) => r.run?.tokenUsage?.totalTokens);

                    case "duration": {
                      const durations = runs
                        .map((r) => {
                          const s = r.run?.startedAt;
                          const e = r.run?.finishedAt;
                          if (!s || !e) return null;
                          return new Date(e).getTime() - new Date(s).getTime();
                        })
                        .filter((n): n is number => n != null && n >= 0);
                      if (durations.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const sum = durations.reduce((a, b) => a + b, 0);
                      return (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="font-mono text-xs cursor-default">{formatDuration(sum)}</span>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">
                            Σ across {durations.length} run{durations.length !== 1 ? "s" : ""}
                          </TooltipContent>
                        </Tooltip>
                      );
                    }

                    case "created": {
                      const times = runs.map((r) => new Date(r.createdAt).getTime()).filter((n) => !Number.isNaN(n));
                      if (times.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      const earliest = new Date(Math.min(...times)).toISOString();
                      const latest = new Date(Math.max(...times)).toISOString();
                      return (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-xs text-muted-foreground cursor-default">{formatDate(earliest)}</span>
                          </TooltipTrigger>
                          <TooltipContent className="text-xs">
                            <div>earliest: {formatDate(earliest)}</div>
                            <div>latest: {formatDate(latest)}</div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    }

                    case "report": {
                      if (!reportSummary) return <span className="text-xs text-muted-foreground">—</span>;
                      const totals = runs.reduce(
                        (acc, r) => {
                          const s = reportSummary[r._id];
                          if (!s) return acc;
                          acc.failed += s.failed;
                          acc.generating += s.generating;
                          acc.pending += s.pending;
                          acc.completed += s.completed;
                          acc.total += s.total;
                          return acc;
                        },
                        { failed: 0, generating: 0, pending: 0, completed: 0, total: 0 },
                      );
                      if (totals.total === 0) return <span className="text-xs text-muted-foreground">—</span>;
                      if (totals.failed > 0)
                        return <Badge variant="destructive" className="text-xs">{totals.failed} failed</Badge>;
                      if (totals.generating > 0)
                        return <Badge variant="secondary" className="text-xs">generating</Badge>;
                      if (totals.pending > 0)
                        return <Badge variant="outline" className="text-xs">{totals.pending} pending</Badge>;
                      if (totals.completed > 0)
                        return <Badge variant="default" className="text-xs">{totals.completed} done</Badge>;
                      return <span className="text-xs text-muted-foreground">—</span>;
                    }
                  }

                  // Default: render the first run's cell (works when the column
                  // value is uniform across the group, e.g. submission/task when
                  // grouped by submissionId, or profile when grouped by profile).
                  return runs[0] ? column.cell(runs[0]) : null;
                },
                renderGroupHeader: (groupKey, runs, expanded) => {
                  const groupLabel = groupBy === "submissionId" ? "Submission ID" : groupBy === "profile" ? "Profile" : "Task";
                  const groupDisplayKey =
                    groupBy === "profile" && groupKey !== "(No Profile)"
                      ? (profileNameById.get(groupKey) ?? formatId(groupKey))
                      : groupKey;
                  return (
                    <button
                      type="button"
                      onClick={() => toggleGroupExpansion(groupKey)}
                      className="w-full bg-muted/30 px-4 py-3 text-sm flex items-center justify-between gap-3 hover:bg-muted/40 transition-colors"
                      aria-expanded={expanded}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {expanded ? (
                          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <span className="min-w-0 truncate font-semibold">
                          <span className="text-muted-foreground">{groupLabel}:</span> {groupDisplayKey}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-xs text-muted-foreground font-normal">
                          {runs.length} run{runs.length !== 1 ? "s" : ""}
                        </span>
                        <span className="text-xs text-muted-foreground font-normal">
                          {expanded ? "Click to collapse" : "Click to expand"}
                        </span>
                      </div>
                    </button>
                  );
                },
              }}
              sort={state.sort}
              sortDir={state.sortDir}
              onSortChange={state.toggleSort}
              loading={isLoading}
              emptyState=""
            />
            {groupedRuns.length === 0 && (
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
