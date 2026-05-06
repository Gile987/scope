// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, OutcomeBadge } from "@/components/StatusBadge";
import { Trash2, Eye, Plus, RefreshCw, Repeat, FileText, X, Download, Archive, ChevronRight, ChevronDown, ChevronLeft, Lock, Settings2, RotateCcw, Pause, Play, ArrowUpDown } from "lucide-react";
import { formatDate, formatId, truncate, formatDuration } from "@/lib/utils";
import { WORKER_TYPES, STATUS_LIST, OUTCOME_LIST } from "@/types";
import type { Run, BulkResubmitOverrides, McpServerDocument, CodingAgent, BulkReportSummary, RunGroup, GroupByKey, ProfileWithVersion } from "@/types";
import { formatStatRange } from "@/lib/grouping";
import { criterionResultStyle } from "@/lib/criteria-result";

/** Shows the first `max` badge items, then a +N chip that opens a dropdown for the rest. */
function OverflowBadges({ items, max = 1, renderItem, renderMenuItem }: {
  items: string[];
  max?: number;
  renderItem: (item: string) => React.ReactNode;
  renderMenuItem: (item: string) => React.ReactNode;
}) {
  const visible = items.slice(0, max);
  const hidden = items.slice(max);
  return (
    <div className="flex gap-1 items-center min-w-0">
      {visible.map((item) => renderItem(item))}
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono bg-muted hover:bg-accent transition-colors cursor-pointer shrink-0">
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

// --- Column visibility ---
// We store *hidden* columns so that newly added columns are visible by default.
type ColumnId = "id" | "submission" | "task" | "criteria" | "worker" | "version" | "os" | "mcp" | "skills" | "extensions" | "profile" | "priority" | "status" | "outcome" | "report" | "attempt" | "turns" | "llmCalls" | "duration" | "tokens" | "created";

const COLUMN_DEFS: { id: ColumnId; label: string }[] = [
  { id: "id", label: "ID" },
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

const ALL_COLUMN_IDS: ColumnId[] = COLUMN_DEFS.map((c) => c.id);
const STORAGE_KEY = "scope:runs-hidden-columns";

function loadHiddenColumns(): Set<ColumnId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ColumnId[];
      if (Array.isArray(parsed)) return new Set(parsed.filter((c) => ALL_COLUMN_IDS.includes(c)));
    }
  } catch { /* ignore */ }
  return new Set();
}

function saveHiddenColumns(hidden: Set<ColumnId>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...hidden]));
}

export function RunsList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const taskPromptId = searchParams.get("taskPromptId") ?? undefined;
  const criteriaState = searchParams.get("criteria") ?? undefined;
  const submissionId = searchParams.get("submissionId") ?? undefined;
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
  const [workerFilter, setWorkerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [outcomeFilter, setOutcomeFilter] = useState("all");
  const [taskFilter, setTaskFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<GroupByKey>("none");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [resubmitCount, setResubmitCount] = useState(1);
  const [resubmitDialogOpen, setResubmitDialogOpen] = useState(false);
  const [resubmitOverrides, setResubmitOverrides] = useState<BulkResubmitOverrides>({});
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [priorityDialogOpen, setPriorityDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorDirection, setCursorDirection] = useState<"after" | "before" | undefined>(undefined);
  const [hiddenColumns, setHiddenColumns] = useState<Set<ColumnId>>(loadHiddenColumns);
  const queryClient = useQueryClient();

  const toggleColumn = useCallback((col: ColumnId) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      saveHiddenColumns(next);
      return next;
    });
  }, []);

  const isCol = useCallback((col: ColumnId) => !hiddenColumns.has(col), [hiddenColumns]);

  const resetCursor = useCallback(() => {
    setCursor(undefined);
    setCursorDirection(undefined);
  }, []);

  // Merge URL taskPromptId with dropdown taskFilter (dropdown takes precedence)
  const effectiveTaskPromptId = taskFilter !== "all" ? taskFilter : taskPromptId;
  const effectiveStatus = statusFilter !== "all" ? statusFilter : undefined;
  const effectiveOutcome = outcomeFilter !== "all" ? outcomeFilter : undefined;

  const { data: runsResponse, isLoading, isRefetching } = useQuery({
    queryKey: ["runs", workerFilter, effectiveTaskPromptId, statusFilter, outcomeFilter, criteriaState, submissionId, cursor, cursorDirection, limit],
    queryFn: () => api.listRuns({
      worker: workerFilter === "all" ? undefined : workerFilter,
      taskPromptId: effectiveTaskPromptId,
      status: effectiveStatus,
      outcome: effectiveOutcome,
      criteria: criteriaState,
      submissionId,
      limit: limit,
      after: cursorDirection === "after" ? cursor : undefined,
      before: cursorDirection === "before" ? cursor : undefined,
    }),
    enabled: groupBy === "none",
    refetchInterval: 10_000,
  });
  const runs = runsResponse?.data ?? [];
  const runsCursors = runsResponse?.cursors ?? { next: null, prev: null };

  // Fetch server-side groups when groupBy is active
  const { data: groupsResponse, isLoading: isGroupsLoading, isRefetching: isGroupsRefetching } = useQuery({
    queryKey: ["run-groups", groupBy, workerFilter, effectiveTaskPromptId, statusFilter, outcomeFilter, criteriaState, submissionId, cursor, cursorDirection, limit],
    queryFn: () => api.listRunGroups({
      groupBy: groupBy as "task" | "submissionId" | "profile",
      worker: workerFilter === "all" ? undefined : workerFilter,
      taskPromptId: effectiveTaskPromptId,
      status: effectiveStatus,
      outcome: effectiveOutcome,
      criteria: criteriaState,
      submissionId,
      limit: limit,
      after: cursorDirection === "after" ? cursor : undefined,
      before: cursorDirection === "before" ? cursor : undefined,
    }),
    enabled: groupBy !== "none",
    refetchInterval: 10_000,
  });
  const serverGroups = groupsResponse?.data ?? [];
  const groupsCursors = groupsResponse?.cursors ?? { next: null, prev: null };
  const estimatedTotal = (groupBy !== "none" ? groupsResponse : runsResponse)?.estimatedTotal;

  // Fetch MCP servers for the resubmit dialog
  const { data: mcpServers = [] } = useQuery<McpServerDocument[]>({
    queryKey: ["mcp-servers"],
    queryFn: api.listMcpServers,
  });

  // Fetch agents for model selection in resubmit dialog
  const { data: agents = [] } = useQuery<CodingAgent[]>({
    queryKey: ["agents"],
    queryFn: api.listAgents,
  });
  const activeAgents = useMemo(() => agents.filter((a) => !a.deletedAt), [agents]);

  // Fetch profiles for name lookup
  const { data: profiles = [] } = useQuery<ProfileWithVersion[]>({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });
  const profileNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of profiles) map.set(p._id, p.name);
    return map;
  }, [profiles]);

  // Parse version number from profileVersionId (format: "<profileId>@<version>")
  const parseProfileVersion = (pvId?: string): number | null => {
    if (!pvId) return null;
    const v = pvId.split("@")[1];
    return v ? Number(v) : null;
  };

  // Fetch bulk report summary for all visible runs
  const runIds = useMemo(() => runs.map((r) => r._id), [runs]);
  const { data: reportSummaries } = useQuery({
    queryKey: ["report-summaries", runIds],
    queryFn: () => api.bulkReportSummary(runIds),
    enabled: runIds.length > 0,
    refetchInterval: 10_000,
  });

  // Derive unique task options (name + taskPromptId) from runs or server groups
  const taskOptions = useMemo(() => {
    const seen = new Map<string, string>(); // taskPromptId → task name
    if (groupBy === "none") {
      for (const r of runs) {
        if (r.taskPromptId && r.scenario?.task && !seen.has(r.taskPromptId)) {
          seen.set(r.taskPromptId, r.scenario.task);
        }
      }
    } else if (groupBy === "task") {
      for (const g of serverGroups) {
        if (g.key && g.label && !seen.has(g.key)) {
          seen.set(g.key, g.label);
        }
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [runs, serverGroups, groupBy]);

  // Compute summary of selected runs' values for the resubmit dialog
  const selectedRunsSummary = useMemo(() => {
    const selected = runs.filter((r) => selectedIds.has(r._id));
    if (selected.length === 0) return { worker: null, model: null, maxIterations: null, mcpServers: null, profileId: null };

    const workers = [...new Set(selected.map((r) => r.workerType))];
    const models = [...new Set(selected.map((r) => r.model ?? ""))];
    const iterations = [...new Set(selected.map((r) => r.maxIterations ?? 0))];
    const mcpSets = selected.map((r) => (r.mcpServers ?? []).sort().join(","));
    const uniqueMcp = [...new Set(mcpSets)];
    const skillSets = selected.map((r) => (r.skillRevisions ?? []).sort().join(","));
    const uniqueSkills = [...new Set(skillSets)];
    const extSets = selected.map((r) => (r.extensions ?? []).sort().join(","));
    const uniqueExts = [...new Set(extSets)];
    const profileIds = [...new Set(selected.map((r) => r.profileId ?? ""))];
    const profileVersions = [...new Set(selected.map((r) =>
      parseProfileVersion(r.profileVersionId) ?? 0
    ))];

    return {
      worker: workers.length === 1 ? workers[0] : null,
      model: models.length === 1 ? (models[0] || null) : null,
      maxIterations: iterations.length === 1 ? (iterations[0] || null) : null,
      mcpServers: uniqueMcp.length === 1 ? (selected[0].mcpServers ?? []) : null,
      skillRevisions: uniqueSkills.length === 1 ? (selected[0].skillRevisions ?? []) : null,
      extensions: uniqueExts.length === 1 ? (selected[0].extensions ?? []) : null,
      profileId: profileIds.length === 1 ? (profileIds[0] || null) : null,
      profileVersion: profileVersions.length === 1 ? (profileVersions[0] || null) : null,
      isMultiWorker: workers.length > 1,
      isMultiModel: models.length > 1,
      isMultiIterations: iterations.length > 1,
      isMultiMcp: uniqueMcp.length > 1,
      isMultiSkills: uniqueSkills.length > 1,
      isMultiExtensions: uniqueExts.length > 1,
      isMultiProfile: profileIds.length > 1,
    };
  }, [runs, selectedIds]);

  // Determine the active profile for the resubmit dialog
  // undefined = keep from source, null = detach, string = specific profile
  const activeProfileId = resubmitOverrides.profileId !== undefined
    ? resubmitOverrides.profileId
    : selectedRunsSummary.profileId;
  const activeProfile = useMemo(
    () => activeProfileId ? profiles.find((p) => p._id === activeProfileId) ?? null : null,
    [profiles, activeProfileId],
  );

  // Determine supported models for the effective worker in the resubmit dialog
  // When a profile is active, its values take precedence
  const effectiveWorker = activeProfile
    ? activeProfile.version.workerType
    : (resubmitOverrides.workerType ?? selectedRunsSummary.worker);
  const effectiveAgent = useMemo(
    () => activeAgents.find((a) => a._id === effectiveWorker),
    [activeAgents, effectiveWorker],
  );
  const availableModels = effectiveAgent?.supportedModels ?? [];

  const deleteMutation = useMutation({
    mutationFn: api.deleteRun,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["runs"] }),
  });

  const retryMutation = useMutation({
    mutationFn: api.retryRun,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      toast.success(`Retry started — attempt #${data.attemptNumber}`);
    },
    onError: (error) => {
      toast.error("Failed to retry", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: api.pauseRun,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      toast.success("Run paused");
    },
    onError: (error) => {
      toast.error("Failed to pause", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: api.resumeRun,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      toast.success("Run resumed");
    },
    onError: (error) => {
      toast.error("Failed to resume", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const setPriorityMutation = useMutation({
    mutationFn: ({ id, priority }: { id: string; priority: number }) => api.setPriority(id, priority),
    onSuccess: (_data, { priority }) => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      toast.success(`Priority set to ${priority}`);
    },
    onError: (error) => {
      toast.error("Failed to set priority", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const bulkRetryMutation = useMutation({
    mutationFn: (ids: string[]) => api.bulkRetryRuns(ids),
    onSuccess: ({ retried, skipped }) => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      const parts: string[] = [];
      if (retried > 0) parts.push(`${retried} retried`);
      if (skipped > 0) parts.push(`${skipped} skipped`);
      if (skipped > 0 && retried === 0) {
        toast.warning(`Bulk retry: ${parts.join(", ")}`);
      } else {
        toast.success(`Bulk retry: ${parts.join(", ")}`);
      }
    },
    onError: (error) => {
      toast.error("Bulk retry failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: api.bulkDeleteRuns,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      setSelectedIds(new Set());
      toast.success(`Deleted ${data.deleted} run${data.deleted !== 1 ? "s" : ""}`);
    },
    onError: (error) => {
      toast.error("Failed to delete runs", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const bulkPauseMutation = useMutation({
    mutationFn: (ids: string[]) => api.bulkPauseRuns(ids),
    onSuccess: ({ paused, skipped }) => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      const parts: string[] = [];
      if (paused > 0) parts.push(`${paused} paused`);
      if (skipped > 0) parts.push(`${skipped} skipped`);
      toast.success(`Bulk pause: ${parts.join(", ")}`);
    },
    onError: (error) => {
      toast.error("Bulk pause failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const bulkResumeMutation = useMutation({
    mutationFn: (ids: string[]) => api.bulkResumeRuns(ids),
    onSuccess: ({ resumed, skipped }) => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      const parts: string[] = [];
      if (resumed > 0) parts.push(`${resumed} resumed`);
      if (skipped > 0) parts.push(`${skipped} skipped`);
      toast.success(`Bulk resume: ${parts.join(", ")}`);
    },
    onError: (error) => {
      toast.error("Bulk resume failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const [bulkPriorityValue, setBulkPriorityValue] = useState<number>(0);

  const bulkSetPriorityMutation = useMutation({
    mutationFn: ({ ids, priority }: { ids: string[]; priority: number }) => api.bulkSetPriority(ids, priority),
    onSuccess: ({ updated }) => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      toast.success(`Priority updated for ${updated} run${updated !== 1 ? "s" : ""}`);
    },
    onError: (error) => {
      toast.error("Bulk priority update failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const bulkResubmitMutation = useMutation({
    mutationFn: ({ ids, count, overrides }: { ids: string[]; count: number; overrides?: BulkResubmitOverrides }) =>
      api.bulkResubmitRuns(ids, count, Object.keys(overrides ?? {}).length > 0 ? overrides : undefined),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      setSelectedIds(new Set());
      setResubmitDialogOpen(false);
      setResubmitCount(1);
      setResubmitOverrides({});
      toast.success(`Re-submitted ${data.submitted} run${data.submitted !== 1 ? "s" : ""}`);
    },
    onError: (error) => {
      toast.error("Failed to re-submit runs", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const batchDownloadMutation = useMutation({
    mutationFn: (ids: string[]) => api.batchArchive(ids),
    onSuccess: () => {
      toast.success(`Downloading ${selectedIds.size} run${selectedIds.size !== 1 ? "s" : ""}`);
    },
    onError: (error) => {
      toast.error("Failed to download batch archive", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  const bulkReportMutation = useMutation({
    mutationFn: (ids: string[]) => api.bulkTriggerReports(ids),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["report-statuses"] });
      setSelectedIds(new Set());
      toast.success(`Queued ${data.created} report${data.created !== 1 ? "s" : ""} for generation`);
      if (data.notFound.length > 0) {
        toast.warning(`${data.notFound.length} run${data.notFound.length !== 1 ? "s" : ""} not found`);
      }
    },
    onError: (error) => {
      toast.error("Failed to generate reports", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    },
  });

  // Compute which bulk actions are available based on selected runs' statuses
  const selectionCaps = useMemo(() => {
    if (groupBy === "none") {
      // Flat list mode — we have full run objects
      const selected = runs.filter((r) => selectedIds.has(r._id));
      const status = (r: Run) => r.run?.status ?? "pending";
      return {
        pausable: selected.filter((r) => status(r) === "pending" || status(r) === "queued").length,
        resumable: selected.filter((r) => status(r) === "paused").length,
        prioritizable: selected.filter((r) => status(r) === "pending" || status(r) === "paused").length,
        retryable: selected.filter((r) => status(r) === "done").length,
      };
    }
    // Grouped mode — derive caps from group-level statusCounts for groups
    // whose runs are (partially or fully) selected
    let pausable = 0, resumable = 0, prioritizable = 0, retryable = 0;
    for (const group of serverGroups) {
      const selectedInGroup = group.runIds.filter((id) => selectedIds.has(id)).length;
      if (selectedInGroup === 0) continue;
      const sc = group.aggregates.statusCounts;
      const ratio = selectedInGroup / group.runIds.length;
      if (selectedInGroup === group.runIds.length) {
        // All runs in group selected — use exact counts
        pausable += (sc.pending ?? 0) + (sc.queued ?? 0);
        resumable += sc.paused ?? 0;
        prioritizable += (sc.pending ?? 0) + (sc.paused ?? 0);
        retryable += sc.done ?? 0;
      } else {
        // Partial selection — estimate proportionally (round up to be permissive)
        pausable += Math.ceil(((sc.pending ?? 0) + (sc.queued ?? 0)) * ratio);
        resumable += Math.ceil((sc.paused ?? 0) * ratio);
        prioritizable += Math.ceil(((sc.pending ?? 0) + (sc.paused ?? 0)) * ratio);
        retryable += Math.ceil((sc.done ?? 0) * ratio);
      }
    }
    return { pausable, resumable, prioritizable, retryable };
  }, [runs, selectedIds, groupBy, serverGroups]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allSelected = runs.length > 0 && runs.every((r) => selectedIds.has(r._id));
  const someSelected = runs.some((r) => selectedIds.has(r._id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(runs.map((r) => r._id)));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateTableScrollIndicators = useCallback(() => {
    const el = tableScrollRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const hasOverflow = el.scrollWidth - el.clientWidth > 1;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setCanScrollLeft(hasOverflow && left);
    setCanScrollRight(hasOverflow && right);
  }, []);

  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;

    updateTableScrollIndicators();
    const onScroll = () => updateTableScrollIndicators();
    el.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTableScrollIndicators());
    resizeObserver.observe(el);
    const tableElement = el.querySelector("table");
    if (tableElement) resizeObserver.observe(tableElement);

    window.addEventListener("resize", onScroll);

    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTableScrollIndicators, hiddenColumns, groupBy, runs.length, serverGroups.length]);

  return (
    <TooltipProvider delayDuration={200}>
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Runs</h1>
          <p className="text-muted-foreground">Manage and monitor benchmark runs</p>
        </div>
        <Link to="/runs/new">
          <Button className="gap-1.5">
            <Plus className="h-4 w-4" /> New Run
          </Button>
        </Link>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Worker:</span>
          <Select value={workerFilter} onValueChange={(v) => { setWorkerFilter(v); setTaskFilter("all"); resetCursor(); }}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="All workers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All workers</SelectItem>
              {WORKER_TYPES.map((w) => (
                <SelectItem key={w} value={w}>{w}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Status:</span>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); resetCursor(); }}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUS_LIST.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Outcome:</span>
          <Select value={outcomeFilter} onValueChange={(v) => { setOutcomeFilter(v); resetCursor(); }}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All outcomes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All outcomes</SelectItem>
              {OUTCOME_LIST.map((o) => (
                <SelectItem key={o} value={o}>{o}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Task:</span>
          <Select value={taskFilter} onValueChange={(v) => { setTaskFilter(v); resetCursor(); }}>
            <SelectTrigger className="w-[260px]">
              <SelectValue placeholder="All tasks" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tasks</SelectItem>
              {taskOptions.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  <span title={t.name}>{truncate(t.name, 50)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Group by:</span>
          <Select value={groupBy} onValueChange={(v) => { setGroupBy(v as GroupByKey); setExpandedGroups(new Set()); resetCursor(); }}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="task">Task</SelectItem>
              <SelectItem value="submissionId">Submission ID</SelectItem>
              <SelectItem value="profile">Profile</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Settings2 className="h-4 w-4" /> Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {COLUMN_DEFS.map((col) => (
              <DropdownMenuCheckboxItem
                key={col.id}
                checked={!hiddenColumns.has(col.id)}
                onCheckedChange={() => toggleColumn(col.id)}
                onSelect={(e) => e.preventDefault()}
              >
                {col.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />
        {(isRefetching || isGroupsRefetching) && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
        <span className="text-sm text-muted-foreground">
          {groupBy !== "none"
            ? `${serverGroups.length} group${serverGroups.length !== 1 ? "s" : ""}`
            : `${runs.length} run${runs.length !== 1 ? "s" : ""}`}
          {estimatedTotal != null && ` (~${estimatedTotal.toLocaleString()} total runs)`}
        </span>
      </div>

      {/* MDP criteria state filter indicator */}
      {criteriaState && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
          <span className="text-sm text-muted-foreground">Filtered by criteria state:</span>
          <div className="flex items-center gap-1">
            {criteriaState.split("|").map((part) => {
              const lastColon = part.lastIndexOf(":");
              const id = lastColon !== -1 ? part.slice(0, lastColon) : part;
              const passed = lastColon !== -1 ? part.slice(lastColon + 1) === "1" : false;
              return (
                <Badge
                  key={part}
                  variant="secondary"
                  className={`text-xs ${
                    passed
                      ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                      : "bg-red-500/20 text-red-400 border-red-500/30"
                  }`}
                >
                  {id}: {passed ? "pass" : "fail"}
                </Badge>
              );
            })}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete("criteria");
              setSearchParams(next);
            }}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Task prompt filter indicator */}
      {taskPromptId && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
          <span className="text-sm text-muted-foreground">Filtered by task prompt:</span>
          <Link to={`/task-prompts/${taskPromptId}`}>
            <Badge variant="secondary" className="font-mono text-xs hover:bg-accent cursor-pointer">
              {formatId(taskPromptId)}
            </Badge>
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete("taskPromptId");
              setSearchParams(next);
            }}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Submission ID filter indicator */}
      {submissionId && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
          <span className="text-sm text-muted-foreground">Filtered by submission:</span>
          <Badge variant="secondary" className="font-mono text-xs">
            {formatId(submissionId)}
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete("submissionId");
              setSearchParams(next);
            }}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-4 py-2">
          <span className="text-sm font-medium whitespace-nowrap">
            {selectedIds.size} <span className="hidden sm:inline">run{selectedIds.size !== 1 ? "s" : ""} selected</span>
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelectedIds(new Set())}>
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear selection</TooltipContent>
          </Tooltip>
          <div className="flex-1" />
          {/* Scheduling */}
          <span className="hidden 2xl:inline text-xs font-semibold text-muted-foreground uppercase tracking-wide">Scheduling</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={bulkPauseMutation.isPending || selectionCaps.pausable === 0}
                onClick={() => bulkPauseMutation.mutate(Array.from(selectedIds))}
              >
                <Pause className="h-4 w-4" />
                <span className="hidden md:inline">{bulkPauseMutation.isPending ? "…" : `Pause${selectionCaps.pausable > 0 ? ` (${selectionCaps.pausable})` : ""}`}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Pause pending/queued runs{selectionCaps.pausable > 0 ? ` (${selectionCaps.pausable})` : ""}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={bulkResumeMutation.isPending || selectionCaps.resumable === 0}
                onClick={() => bulkResumeMutation.mutate(Array.from(selectedIds))}
              >
                <Play className="h-4 w-4" />
                <span className="hidden md:inline">{bulkResumeMutation.isPending ? "…" : `Resume${selectionCaps.resumable > 0 ? ` (${selectionCaps.resumable})` : ""}`}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Resume paused runs{selectionCaps.resumable > 0 ? ` (${selectionCaps.resumable})` : ""}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={selectionCaps.prioritizable === 0}
                onClick={() => {
                  // Pre-fill with the common priority of selected prioritizable runs
                  const prioritizable = runs.filter((r) => selectedIds.has(r._id) && ((r.run?.status ?? "pending") === "pending" || r.run?.status === "paused"));
                  const priorities = new Set(prioritizable.map((r) => r.priority ?? 0));
                  setBulkPriorityValue(priorities.size === 1 ? [...priorities][0] : 0);
                  setPriorityDialogOpen(true);
                }}
              >
                <ArrowUpDown className="h-4 w-4" />
                <span className="hidden lg:inline">{`Priority${selectionCaps.prioritizable > 0 ? ` (${selectionCaps.prioritizable})` : ""}`}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Set priority on pending/paused runs{selectionCaps.prioritizable > 0 ? ` (${selectionCaps.prioritizable})` : ""}</TooltipContent>
          </Tooltip>
          {/* Runs */}
          <span className="hidden 2xl:inline text-xs font-semibold text-muted-foreground uppercase tracking-wide ml-2">Runs</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setResubmitDialogOpen(true)}>
                <Repeat className="h-4 w-4" /> <span className="hidden lg:inline">Re-submit</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Re-submit selected runs with optional overrides</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={bulkRetryMutation.isPending || selectionCaps.retryable === 0}
                onClick={() => bulkRetryMutation.mutate(Array.from(selectedIds))}
              >
                <RotateCcw className="h-4 w-4" />
                <span className="hidden md:inline">{bulkRetryMutation.isPending ? "…" : `Retry${selectionCaps.retryable > 0 ? ` (${selectionCaps.retryable})` : ""}`}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Retry completed runs{selectionCaps.retryable > 0 ? ` (${selectionCaps.retryable})` : ""}</TooltipContent>
          </Tooltip>
          {/* Export */}
          <span className="hidden 2xl:inline text-xs font-semibold text-muted-foreground uppercase tracking-wide ml-2">Export</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setReportDialogOpen(true)}>
                <FileText className="h-4 w-4" /> <span className="hidden xl:inline">Reports</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Generate reports for selected runs</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={batchDownloadMutation.isPending}
                onClick={() => batchDownloadMutation.mutate(Array.from(selectedIds))}
              >
                <Archive className="h-4 w-4" />
                <span className="hidden xl:inline">{batchDownloadMutation.isPending ? "…" : "Download"}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download selected runs as archive</TooltipContent>
          </Tooltip>
          {/* Delete */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="destructive" size="icon" className="h-8 w-8 ml-2" onClick={() => setDeleteDialogOpen(true)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete selected</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Bulk action dialogs (controlled, opened from dropdown menu) */}
      <AlertDialog open={reportDialogOpen} onOpenChange={setReportDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Generate reports for {selectedIds.size} run{selectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will queue report generation for each selected run. Runs that already have a report will get a new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => bulkReportMutation.mutate(Array.from(selectedIds))}
              disabled={bulkReportMutation.isPending}
            >
              {bulkReportMutation.isPending ? "Generating…" : "Generate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resubmitDialogOpen} onOpenChange={setResubmitDialogOpen}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Re-submit {selectedIds.size} run{selectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              New runs copy the original scenario and settings. Use overrides below to change specific fields.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4 py-2">
            {/* Copies per run */}
            <div className="flex items-center gap-4">
              <Label htmlFor="resubmit-count" className="text-sm font-medium w-32 shrink-0">Copies per run</Label>
              <Input
                id="resubmit-count"
                type="number"
                min={1}
                max={10}
                value={resubmitCount}
                onChange={(e) => setResubmitCount(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                className="w-24"
              />
              <span className="text-xs text-muted-foreground">
                = {selectedIds.size * resubmitCount} new run{selectedIds.size * resubmitCount !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="border-t pt-4">
              <p className="text-sm font-medium mb-3">Overrides <span className="text-muted-foreground font-normal">(leave unchanged to copy from source)</span></p>

              {/* Profile override */}
              <div className="flex items-center gap-4 mb-3">
                <Label className="text-sm w-32 shrink-0">Profile</Label>
                <Select
                  value={resubmitOverrides.profileId === null ? "__none__" : resubmitOverrides.profileId ?? "__keep__"}
                  onValueChange={(v) => setResubmitOverrides((prev) => {
                    const next = { ...prev };
                    if (v === "__keep__") {
                      delete next.profileId;
                    } else if (v === "__none__") {
                      next.profileId = null;
                    } else {
                      next.profileId = v;
                    }
                    // Clear individual overrides for profile-controlled fields when
                    // switching profiles — profile values take precedence
                    delete next.workerType;
                    delete next.model;
                    delete next.mcpServers;
                    delete next.skillRevisions;
                    delete next.extensions;
                    return next;
                  })}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__keep__">
                      {selectedRunsSummary.profileId
                        ? <>
                            {profileNameMap.get(selectedRunsSummary.profileId) ?? formatId(selectedRunsSummary.profileId)}
                            {selectedRunsSummary.profileVersion && <span className="text-muted-foreground"> v{selectedRunsSummary.profileVersion}</span>}
                          </>
                        : selectedRunsSummary.isMultiProfile ? "Mixed (keep each)" : "None"}
                    </SelectItem>
                    <SelectItem value="__none__">None (detach profile)</SelectItem>
                    {profiles.map((p) => (
                      <SelectItem key={p._id} value={p._id}>
                        {p.name} <span className="text-muted-foreground">v{p.latestVersion}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {activeProfile && (
                <div className="flex items-center gap-2 mb-3 px-1 py-1.5 text-xs text-muted-foreground bg-muted/50 rounded">
                  <Lock className="h-3 w-3 shrink-0" />
                  Worker, model, MCP servers, skills, and extensions are controlled by the profile
                </div>
              )}

              {/* Worker type override */}
              <div className="flex items-center gap-4 mb-3" title={activeProfile ? "Controlled by profile" : undefined}>
                <Label className="text-sm w-32 shrink-0 flex items-center gap-1.5">
                  {activeProfile && <Lock className="h-3 w-3 text-muted-foreground" />}
                  Worker
                </Label>
                {activeProfile ? (
                  <span className="text-sm text-muted-foreground">{activeProfile.version.workerType}</span>
                ) : (
                <Select
                  value={resubmitOverrides.workerType ?? "__keep__"}
                  onValueChange={(v) => setResubmitOverrides((prev) => {
                    const next = { ...prev };
                    if (v === "__keep__") { delete next.workerType; } else { next.workerType = v; }
                    // Reset model override when worker changes (supported models differ per worker)
                    delete next.model;
                    // Manage extensions: clear for non-vscode workers, restore for vscode workers
                    const effectiveWorkerType = v === "__keep__" ? selectedRunsSummary.worker : v;
                    if (effectiveWorkerType && !effectiveWorkerType.includes("vscode")) {
                      next.extensions = null;
                    } else {
                      delete next.extensions;
                    }
                    return next;
                  })}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__keep__">
                      {selectedRunsSummary.worker
                        ? selectedRunsSummary.worker
                        : selectedRunsSummary.isMultiWorker ? "Mixed (keep each)" : "—"}
                    </SelectItem>
                    {WORKER_TYPES.filter((w) => w !== selectedRunsSummary.worker).map((w) => (
                      <SelectItem key={w} value={w}>{w}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                )}
              </div>

              {/* Model override */}
              <div className="flex items-center gap-4 mb-3" title={activeProfile ? "Controlled by profile" : undefined}>
                <Label className="text-sm w-32 shrink-0 flex items-center gap-1.5">
                  {activeProfile && <Lock className="h-3 w-3 text-muted-foreground" />}
                  Model
                </Label>
                {activeProfile ? (
                  <span className="text-sm text-muted-foreground">{activeProfile.version.model}</span>
                ) : (
                <Select
                  value={resubmitOverrides.model === null ? "__clear__" : resubmitOverrides.model ?? "__keep__"}
                  onValueChange={(v) => setResubmitOverrides((prev) => {
                    const next = { ...prev };
                    if (v === "__keep__") { delete next.model; }
                    else if (v === "__clear__") { next.model = null; }
                    else { next.model = v; }
                    return next;
                  })}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__keep__">
                      {selectedRunsSummary.model
                        ? selectedRunsSummary.model
                        : selectedRunsSummary.isMultiModel ? "Mixed (keep each)" : "Default"}
                    </SelectItem>
                    <SelectItem value="__clear__">Clear (use default)</SelectItem>
                    {availableModels.filter((m) => m !== selectedRunsSummary.model).map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}{m === effectiveAgent?.defaultModel ? " (default)" : ""}
                      </SelectItem>
                    ))}
                    {!effectiveWorker && (
                      <SelectItem value="__hint__" disabled>
                        Select a worker to see models
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                )}
              </div>

              {/* Max iterations override */}
              <div className="flex items-center gap-4 mb-3">
                <Label className="text-sm w-32 shrink-0">Max iterations</Label>
                <Select
                  value={resubmitOverrides.maxIterations === null ? "__clear__" : resubmitOverrides.maxIterations?.toString() ?? "__keep__"}
                  onValueChange={(v) => setResubmitOverrides((prev) => {
                    const next = { ...prev };
                    if (v === "__keep__") { delete next.maxIterations; }
                    else if (v === "__clear__") { next.maxIterations = null; }
                    else { next.maxIterations = parseInt(v); }
                    return next;
                  })}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__keep__">
                      {selectedRunsSummary.maxIterations
                        ? String(selectedRunsSummary.maxIterations)
                        : selectedRunsSummary.isMultiIterations ? "Mixed (keep each)" : "Default"}
                    </SelectItem>
                    <SelectItem value="__clear__">Clear (use default)</SelectItem>
                    {[1, 2, 3, 5, 10, 15, 20].filter((n) => n !== selectedRunsSummary.maxIterations).map((n) => (
                      <SelectItem key={n} value={n.toString()}>{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* MCP servers override */}
              {activeProfile ? (
              <div className="flex items-start gap-4 mb-3" title="Controlled by profile">
                <Label className="text-sm w-32 shrink-0 pt-0.5 flex items-center gap-1.5">
                  <Lock className="h-3 w-3 text-muted-foreground" />MCP Servers
                </Label>
                <span className="text-sm text-muted-foreground">
                  {activeProfile.version.mcpServers?.join(", ") || "None"}
                </span>
              </div>
              ) : (
              <div className="flex items-start gap-4">
                <Label className="text-sm w-32 shrink-0 pt-2">MCP Servers</Label>
                <div className="flex-1 space-y-1.5">
                  <Select
                    value={resubmitOverrides.mcpServers === null ? "__clear__" : resubmitOverrides.mcpServers !== undefined ? "__custom__" : "__keep__"}
                    onValueChange={(v) => setResubmitOverrides((prev) => {
                      const next = { ...prev };
                      if (v === "__keep__") { delete next.mcpServers; }
                      else if (v === "__clear__") { next.mcpServers = null; }
                      else { next.mcpServers = []; }
                      return next;
                    })}
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue>
                        {resubmitOverrides.mcpServers === null
                          ? "Clear (no MCP servers)"
                          : resubmitOverrides.mcpServers !== undefined
                            ? "Choose servers…"
                            : selectedRunsSummary.mcpServers && selectedRunsSummary.mcpServers.length > 0
                              ? selectedRunsSummary.mcpServers.join(", ")
                              : selectedRunsSummary.isMultiMcp ? "Mixed (keep each)" : "None"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__keep__">
                        {selectedRunsSummary.mcpServers && selectedRunsSummary.mcpServers.length > 0
                          ? selectedRunsSummary.mcpServers.join(", ")
                          : selectedRunsSummary.isMultiMcp ? "Mixed (keep each)" : "None"}
                      </SelectItem>
                      <SelectItem value="__clear__">Clear (no MCP servers)</SelectItem>
                      <SelectItem value="__custom__">Choose servers…</SelectItem>
                    </SelectContent>
                  </Select>
                  {resubmitOverrides.mcpServers !== undefined && resubmitOverrides.mcpServers !== null && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {mcpServers.map((s) => {
                        const selected = resubmitOverrides.mcpServers?.includes(s._id) ?? false;
                        return (
                          <Button
                            key={s._id}
                            type="button"
                            variant={selected ? "default" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setResubmitOverrides((prev) => {
                              const current = prev.mcpServers ?? [];
                              const next = selected ? current.filter((id) => id !== s._id) : [...current, s._id];
                              return { ...prev, mcpServers: next };
                            })}
                          >
                            {s.name}
                          </Button>
                        );
                      })}
                      {mcpServers.length === 0 && (
                        <span className="text-xs text-muted-foreground italic">No MCP servers configured</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              )}

              {/* Skills override */}
              {activeProfile ? (
              <div className="flex items-start gap-4 mb-3" title="Controlled by profile">
                <Label className="text-sm w-32 shrink-0 pt-0.5 flex items-center gap-1.5">
                  <Lock className="h-3 w-3 text-muted-foreground" />Skills
                </Label>
                <span className="text-sm text-muted-foreground">
                  {activeProfile.version.skillRevisions?.map((r) => r.split("@")[0].split("/").pop()).join(", ") || "None"}
                </span>
              </div>
              ) : (
              <div className="flex items-start gap-4">
                <Label className="text-sm w-32 shrink-0 pt-2">Skills</Label>
                <div className="flex-1 space-y-1.5">
                  <Select
                    value={resubmitOverrides.skillRevisions === null ? "__clear__" : resubmitOverrides.skillRevisions !== undefined ? "__custom__" : "__keep__"}
                    onValueChange={(v) => setResubmitOverrides((prev) => {
                      const next = { ...prev };
                      if (v === "__keep__") { delete next.skillRevisions; }
                      else if (v === "__clear__") { next.skillRevisions = null; }
                      else { next.skillRevisions = []; }
                      return next;
                    })}
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue>
                        {resubmitOverrides.skillRevisions === null
                          ? "Clear (no skills)"
                          : resubmitOverrides.skillRevisions !== undefined
                            ? "Choose skills…"
                            : selectedRunsSummary.skillRevisions && selectedRunsSummary.skillRevisions.length > 0
                              ? selectedRunsSummary.skillRevisions.map((r) => r.split("@")[0].split("/").pop()).join(", ")
                              : selectedRunsSummary.isMultiSkills ? "Mixed (keep each)" : "None"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__keep__">
                        {selectedRunsSummary.skillRevisions && selectedRunsSummary.skillRevisions.length > 0
                          ? selectedRunsSummary.skillRevisions.map((r) => r.split("@")[0].split("/").pop()).join(", ")
                          : selectedRunsSummary.isMultiSkills ? "Mixed (keep each)" : "None"}
                      </SelectItem>
                      <SelectItem value="__clear__">Clear (no skills)</SelectItem>
                      <SelectItem value="__custom__">Choose skills…</SelectItem>
                    </SelectContent>
                  </Select>
                  {resubmitOverrides.skillRevisions !== undefined && resubmitOverrides.skillRevisions !== null && (() => {
                    // Collect all unique skill revision refs from selected runs
                    const allRefs = [...new Set(
                      runs
                        .filter((r) => selectedIds.has(r._id))
                        .flatMap((r) => r.skillRevisions ?? [])
                    )];
                    return (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {allRefs.map((ref) => {
                          const selected = resubmitOverrides.skillRevisions?.includes(ref) ?? false;
                          const skillName = ref.split("@")[0].split("/").pop() ?? ref;
                          return (
                            <Button
                              key={ref}
                              type="button"
                              variant={selected ? "default" : "outline"}
                              size="sm"
                              className="h-7 text-xs"
                              title={ref}
                              onClick={() => setResubmitOverrides((prev) => {
                                const current = prev.skillRevisions ?? [];
                                const next = selected ? current.filter((r) => r !== ref) : [...current, ref];
                                return { ...prev, skillRevisions: next };
                              })}
                            >
                              {skillName}
                            </Button>
                          );
                        })}
                        {allRefs.length === 0 && (
                          <span className="text-xs text-muted-foreground italic">No skills in selected runs</span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
              )}

              {/* Extensions override — only for VS Code workers */}
              {activeProfile ? (
                effectiveWorker?.includes("vscode") && (
                <div className="flex items-start gap-4 mb-3" title="Controlled by profile">
                  <Label className="text-sm w-32 shrink-0 pt-0.5 flex items-center gap-1.5">
                    <Lock className="h-3 w-3 text-muted-foreground" />Extensions
                  </Label>
                  <span className="text-sm text-muted-foreground">
                    {activeProfile.version.extensions?.join(", ") || "None"}
                  </span>
                </div>
                )
              ) : (
              effectiveWorker?.includes("vscode") && (
              <div className="flex items-start gap-4">
                <Label className="text-sm w-32 shrink-0 pt-2">Extensions</Label>
                <div className="flex-1 space-y-1.5">
                  <Select
                    value={resubmitOverrides.extensions === null ? "__clear__" : resubmitOverrides.extensions !== undefined ? "__custom__" : "__keep__"}
                    onValueChange={(v) => setResubmitOverrides((prev) => {
                      const next = { ...prev };
                      if (v === "__keep__") { delete next.extensions; }
                      else if (v === "__clear__") { next.extensions = null; }
                      else { next.extensions = []; }
                      return next;
                    })}
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue>
                        {resubmitOverrides.extensions === null
                          ? "Clear (no extensions)"
                          : resubmitOverrides.extensions !== undefined
                            ? "Choose extensions…"
                            : selectedRunsSummary.extensions && selectedRunsSummary.extensions.length > 0
                              ? selectedRunsSummary.extensions.join(", ")
                              : selectedRunsSummary.isMultiExtensions ? "Mixed (keep each)" : "None"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__keep__">
                        {selectedRunsSummary.extensions && selectedRunsSummary.extensions.length > 0
                          ? selectedRunsSummary.extensions.join(", ")
                          : selectedRunsSummary.isMultiExtensions ? "Mixed (keep each)" : "None"}
                      </SelectItem>
                      <SelectItem value="__clear__">Clear (no extensions)</SelectItem>
                      <SelectItem value="__custom__">Choose extensions…</SelectItem>
                    </SelectContent>
                  </Select>
                  {resubmitOverrides.extensions !== undefined && resubmitOverrides.extensions !== null && (() => {
                    const allExts = [...new Set(
                      runs
                        .filter((r) => selectedIds.has(r._id))
                        .flatMap((r) => r.extensions ?? [])
                    )];
                    return (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {allExts.map((ext) => {
                          const selected = resubmitOverrides.extensions?.includes(ext) ?? false;
                          return (
                            <Button
                              key={ext}
                              type="button"
                              variant={selected ? "default" : "outline"}
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => setResubmitOverrides((prev) => {
                                const current = prev.extensions ?? [];
                                const next = selected ? current.filter((e) => e !== ext) : [...current, ext];
                                return { ...prev, extensions: next };
                              })}
                            >
                              {ext}
                            </Button>
                          );
                        })}
                        {allExts.length === 0 && (
                          <span className="text-xs text-muted-foreground italic">No extensions in selected runs</span>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
              ))}
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setResubmitCount(1); setResubmitOverrides({}); }}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => bulkResubmitMutation.mutate({ ids: Array.from(selectedIds), count: resubmitCount, overrides: resubmitOverrides })}
              disabled={bulkResubmitMutation.isPending}
            >
              {bulkResubmitMutation.isPending ? "Re-submitting…" : "Re-submit"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={priorityDialogOpen} onOpenChange={setPriorityDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Set priority for {selectionCaps.prioritizable} run{selectionCaps.prioritizable !== 1 ? "s" : ""}</AlertDialogTitle>
            <AlertDialogDescription>
              Higher priority runs are dispatched first. Default is 0. Only pending and paused runs will be updated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <Label htmlFor="bulk-priority">Priority</Label>
            <div className="flex items-center gap-2 mt-1">
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => setBulkPriorityValue((v) => Math.max(-100, v - 5))}>−5</Button>
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => setBulkPriorityValue((v) => Math.max(-100, v - 1))}>−1</Button>
              <Input
                id="bulk-priority"
                type="number"
                min={-100}
                max={100}
                value={bulkPriorityValue}
                onChange={(e) => setBulkPriorityValue(Math.max(-100, Math.min(100, parseInt(e.target.value) || 0)))}
                className="w-20 text-center"
              />
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => setBulkPriorityValue((v) => Math.min(100, v + 1))}>+1</Button>
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => setBulkPriorityValue((v) => Math.min(100, v + 5))}>+5</Button>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => bulkSetPriorityMutation.mutate({ ids: Array.from(selectedIds), priority: bulkPriorityValue })}
              disabled={bulkSetPriorityMutation.isPending}
            >
              {bulkSetPriorityMutation.isPending ? "Updating…" : "Set priority"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} run{selectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will soft-delete the selected runs. They can be recovered later if needed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => bulkDeleteMutation.mutate(Array.from(selectedIds))}
              disabled={bulkDeleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {bulkDeleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Table */}
      {(groupBy === "none" ? isLoading : isGroupsLoading) ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (groupBy === "none" && runs.length === 0) || (groupBy !== "none" && serverGroups.length === 0) ? (
        <div className="text-center py-12 text-muted-foreground">
          No runs found. <Link to="/runs/new" className="text-primary underline">Submit one?</Link>
        </div>
      ) : (
        <div className="relative">
          <div
            ref={(node) => {
              tableScrollRef.current = node?.querySelector("div") as HTMLDivElement | null;
            }}
            className="w-full"
          >
        <Table className="min-w-max">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px] sticky left-0 z-10 bg-background shadow-sm">
                {groupBy === "none" && (
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all"
                  />
                )}
              </TableHead>
              {isCol("id") && <TableHead className="w-[100px] sticky left-[40px] z-10 bg-background border-r shadow-sm">ID</TableHead>}
              {isCol("submission") && <TableHead className="w-[100px]">Submission</TableHead>}
              {isCol("task") && <TableHead>Task</TableHead>}
              {isCol("criteria") && <TableHead>Criteria</TableHead>}
              {isCol("worker") && <TableHead className="w-[180px]">Worker</TableHead>}
              {isCol("version") && <TableHead>Version</TableHead>}
              {isCol("os") && <TableHead className="w-[80px]">OS</TableHead>}
              {isCol("mcp") && <TableHead>MCP</TableHead>}
              {isCol("skills") && <TableHead>Skills</TableHead>}
              {isCol("extensions") && <TableHead>Extensions</TableHead>}
              {isCol("profile") && <TableHead>Profile</TableHead>}
              {isCol("priority") && <TableHead className="w-[60px]">Priority</TableHead>}
              {isCol("status") && <TableHead className="w-[100px]">Status</TableHead>}
              {isCol("outcome") && <TableHead className="w-[100px]">Outcome</TableHead>}
              {isCol("report") && <TableHead className="w-[100px]">Report</TableHead>}
              {isCol("attempt") && <TableHead className="w-[60px]">Attempt</TableHead>}
              {isCol("turns") && <TableHead className="w-[80px]">Turns</TableHead>}
              {isCol("llmCalls") && <TableHead className="w-[80px]">LLM Calls</TableHead>}
              {isCol("duration") && <TableHead className="w-[100px]">Duration</TableHead>}
              {isCol("tokens") && <TableHead className="w-[120px]">Tokens</TableHead>}
              {isCol("created") && <TableHead className="w-[160px]">Created</TableHead>}
              <TableHead className="w-[100px] text-center sticky right-0 z-10 bg-background border-l shadow-sm">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groupBy !== "none" ? (
              serverGroups.map((group) => {
                const isExpanded = expandedGroups.has(group.key);
                return (
                  <GroupRows
                    key={group.key}
                    group={group}
                    isExpanded={isExpanded}
                    onToggleExpand={() => toggleGroup(group.key)}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    reportSummaries={reportSummaries}
                    deleteMutation={deleteMutation}
                    retryMutation={retryMutation}
                    pauseMutation={pauseMutation}
                    resumeMutation={resumeMutation}
                    setPriorityMutation={setPriorityMutation}
                    groupBy={groupBy}
                    profileNameMap={profileNameMap}
                    workerFilter={workerFilter === "all" ? undefined : workerFilter}
                    statusFilter={effectiveStatus}
                    outcomeFilter={effectiveOutcome}
                    criteriaState={criteriaState}
                    hiddenColumns={hiddenColumns}
                  />
                );
              })
            ) : (
              runs.map((run: Run) => (
                <RunRow
                  key={run._id}
                  run={run}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  reportSummaries={reportSummaries}
                  deleteMutation={deleteMutation}
                  retryMutation={retryMutation}
                  pauseMutation={pauseMutation}
                  resumeMutation={resumeMutation}
                  setPriorityMutation={setPriorityMutation}
                  profileNameMap={profileNameMap}
                  hiddenColumns={hiddenColumns}
                />
              ))
            )}
          </TableBody>
        </Table>
          </div>
          {canScrollLeft && (
            <div className="pointer-events-none absolute inset-y-0 left-0 z-30 w-8 bg-gradient-to-r from-background to-transparent" />
          )}
          {canScrollRight && (
            <div className="pointer-events-none absolute inset-y-0 right-0 z-30 w-8 bg-gradient-to-l from-background to-transparent" />
          )}
          {canScrollRight && (
            <div className="pointer-events-none absolute right-2 top-2 z-40 inline-flex items-center gap-1 rounded-md border bg-background/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
              More columns
              <ChevronRight className="h-3 w-3" />
            </div>
          )}
        </div>
      )}

      {/* Pagination controls */}
      {(() => {
        const activeCursors = groupBy !== "none" ? groupsCursors : runsCursors;
        if (!activeCursors.prev && !activeCursors.next) return null;
        return (
          <div className="flex items-center justify-center gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!activeCursors.prev}
              onClick={() => { setCursor(activeCursors.prev!); setCursorDirection("before"); }}
            >
              <ChevronLeft className="h-4 w-4 mr-1" /> Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!activeCursors.next}
              onClick={() => { setCursor(activeCursors.next!); setCursorDirection("after"); }}
            >
              Next <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        );
      })()}
    </div>
    </TooltipProvider>
  );
}

function RunRow({
  run,
  selectedIds,
  onToggleSelect,
  reportSummaries,
  deleteMutation,
  retryMutation,
  pauseMutation,
  resumeMutation,
  setPriorityMutation,
  profileNameMap,
  hiddenColumns,
}: {
  run: Run;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  reportSummaries: BulkReportSummary | undefined;
  deleteMutation: { mutate: (id: string) => void; isPending: boolean };
  retryMutation: { mutate: (id: string) => void; isPending: boolean };
  pauseMutation: { mutate: (id: string) => void; isPending: boolean };
  resumeMutation: { mutate: (id: string) => void; isPending: boolean };
  setPriorityMutation: { mutate: (args: { id: string; priority: number }) => void; isPending: boolean };
  profileNameMap: Map<string, string>;
  hiddenColumns: Set<ColumnId>;
}) {
  const isCol = (col: ColumnId) => !hiddenColumns.has(col);
  const [isExpanded, setIsExpanded] = useState(false);

  // For completed runs, build a criterionId → result map from the final
  // turn's criteriaResults. Using the final turn avoids showing stale results
  // from an earlier iteration when the last turn lacked evaluation (e.g. judge failure).
  const isDone = run.run?.status === "done";
  const runTurns = run.run?.turns ?? [];
  const lastTurn = runTurns.length > 0 ? runTurns[runTurns.length - 1] : undefined;
  const criteriaResultsMap: Map<string, boolean | undefined> | undefined = isDone
    ? new Map(
        (lastTurn?.criteriaResults ?? []).map((r) => [
          r.criterionId,
          r.evaluated ? r.passed : undefined,
        ])
      )
    : undefined;

  return (
  <>
    <TableRow className="group" data-state={selectedIds.has(run._id) ? "selected" : undefined}>
      <TableCell className="w-[40px] min-w-[40px] sticky left-0 z-20 bg-background group-hover:bg-muted/50 group-data-[state=selected]:bg-muted shadow-sm">
        <Checkbox
          checked={selectedIds.has(run._id)}
          onCheckedChange={() => onToggleSelect(run._id)}
          aria-label={`Select run ${formatId(run._id)}`}
        />
      </TableCell>
      {isCol("id") && <TableCell className="font-mono text-xs sticky left-[40px] z-10 bg-background group-hover:bg-muted/50 group-data-[state=selected]:bg-muted border-r shadow-sm">
        <Link to={`/runs/${run._id}`} className="text-primary hover:underline">
          {formatId(run._id)}
        </Link>
      </TableCell>}
      {isCol("submission") && <TableCell className="font-mono text-xs">
        {run.submissionId ? (
          <Link
            to={`/runs?submissionId=${run.submissionId}`}
            className="text-primary hover:underline"
            title={run.submissionId}
          >
            {formatId(run.submissionId)}
          </Link>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </TableCell>}
      {isCol("task") && <TableCell className="max-w-[300px]">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default">{truncate(run.scenario?.task ?? "–", 60)}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm whitespace-pre-wrap text-xs">{run.scenario?.task ?? "–"}</TooltipContent>
        </Tooltip>
      </TableCell>}
      {isCol("criteria") && <TableCell>
        {run.scenario?.criteria && run.scenario.criteria.length > 0 ? (
          <OverflowBadges
            items={run.scenario.criteria}
            max={1}
            renderItem={(criterionId) => {
              if (!isDone || !criteriaResultsMap) {
                return (
                  <Tooltip key={criterionId}>
                    <TooltipTrigger asChild>
                      <Link
                        to={`/criteria/${criterionId}`}
                        className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors"
                      >
                        {criterionId}
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs">{criterionId}</TooltipContent>
                  </Tooltip>
                );
              }
              const result = criteriaResultsMap.get(criterionId);
              const { colorClass, Icon, title } = criterionResultStyle(result);
              return (
                <Tooltip key={criterionId}>
                  <TooltipTrigger asChild>
                    <Link
                      to={`/criteria/${criterionId}`}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-mono hover:opacity-80 transition-opacity ${colorClass}`}
                    >
                      <Icon className="h-3 w-3 shrink-0" />
                      {criterionId}
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">{title} — {criterionId}</TooltipContent>
                </Tooltip>
              );
            }}
            renderMenuItem={(criterionId) => {
              if (!isDone || !criteriaResultsMap) {
                return (
                  <DropdownMenuItem key={criterionId} asChild>
                    <Link to={`/criteria/${criterionId}`} className="font-mono text-xs">{criterionId}</Link>
                  </DropdownMenuItem>
                );
              }
              const result = criteriaResultsMap.get(criterionId);
              const { colorClass, Icon } = criterionResultStyle(result);
              return (
                <DropdownMenuItem key={criterionId} asChild>
                  <Link to={`/criteria/${criterionId}`} className={`font-mono text-xs gap-1 ${colorClass}`}>
                    <Icon className="h-3 w-3 shrink-0" />
                    {criterionId}
                  </Link>
                </DropdownMenuItem>
              );
            }}
          />
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>}
      {isCol("worker") && <TableCell className="max-w-[200px]">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-xs truncate block cursor-default">{run.workerType}</span>
          </TooltipTrigger>
          <TooltipContent className="text-xs">{run.workerType}</TooltipContent>
        </Tooltip>
        {run.model && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="block font-mono text-xs text-muted-foreground truncate cursor-default">{run.model}</span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">{run.model}</TooltipContent>
          </Tooltip>
        )}
      </TableCell>}
      {isCol("version") && <TableCell className="max-w-[120px]">
        {run.agentVersion ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-xs truncate block cursor-default">{run.agentVersion}</span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">{run.agentVersion}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>}
      {isCol("os") && <TableCell className="text-center">
        {run.run?.os ? (
          <PlatformIcon platform={run.run?.os.platform} className="h-4 w-4 inline-block" />
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>}
      {isCol("mcp") && <TableCell>
        {run.mcpServers && run.mcpServers.length > 0 ? (
          <OverflowBadges
            items={run.mcpServers}
            max={1}
            renderItem={(slug) => (
              <Tooltip key={slug}>
                <TooltipTrigger asChild>
                  <Link to={`/mcp-servers/${slug}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
                    {slug}
                  </Link>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{slug}</TooltipContent>
              </Tooltip>
            )}
            renderMenuItem={(slug) => (
              <DropdownMenuItem key={slug} asChild>
                <Link to={`/mcp-servers/${slug}`} className="font-mono text-xs">{slug}</Link>
              </DropdownMenuItem>
            )}
          />
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>}
      {isCol("skills") && <TableCell>
        {run.skillRevisions && run.skillRevisions.length > 0 ? (
          <OverflowBadges
            items={run.skillRevisions}
            max={1}
            renderItem={(ref) => {
              const skillName = ref.split("@")[0].split("/").pop() ?? ref;
              const skillSlug = ref.split("@")[0];
              return (
                <Tooltip key={ref}>
                  <TooltipTrigger asChild>
                    <Link to={`/skills/${skillSlug}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
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
                  <Link to={`/skills/${skillSlug}`} className="font-mono text-xs">{skillName}</Link>
                </DropdownMenuItem>
              );
            }}
          />
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>}
      {isCol("extensions") && <TableCell>
        {run.extensions && run.extensions.length > 0 ? (
          <OverflowBadges
            items={run.extensions}
            max={1}
            renderItem={(id) => {
              const [qualifiedName, version] = id.split("@");
              const shortName = qualifiedName.split(".").pop() ?? id;
              const extensionLabel = `${shortName}${version ? `@${version}` : ""}`;
              return (
                <Tooltip key={id}>
                  <TooltipTrigger asChild>
                    <Link to={`/extensions/${qualifiedName}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
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
                  <Link to={`/extensions/${qualifiedName}`} className="font-mono text-xs">{truncate(extensionLabel, 20)}</Link>
                </DropdownMenuItem>
              );
            }}
          />
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>}
      {isCol("profile") && <TableCell>
        {run.profileId ? (
          <Link to={`/profiles/${run.profileId}`} className="text-primary hover:underline">
            {profileNameMap.get(run.profileId) ?? formatId(run.profileId)}
          </Link>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </TableCell>}
      {isCol("priority") && <TableCell className="text-center font-mono text-xs">
        {run.priority ?? 0}
      </TableCell>}
      {isCol("status") && <TableCell>
        <StatusBadge status={run.run?.status ?? "pending"} />
      </TableCell>}
      {isCol("outcome") && <TableCell>
        <OutcomeBadge outcome={run.run?.outcome} />
      </TableCell>}
      {isCol("report") && <TableCell>
        {reportSummaries?.[run._id] ? (
          <Link to={`/runs/${run._id}/reports`} className="block">
            <ReportProgressBar summary={reportSummaries[run._id]} />
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>}
      {isCol("attempt") && <TableCell className="text-center font-mono text-xs">
        {run.run?.attemptNumber ?? 1}
      </TableCell>}
      {isCol("turns") && <TableCell className="text-center">
        {run.run?.turns?.length ?? "–"}
      </TableCell>}
      {isCol("llmCalls") && <TableCell className="text-center font-mono text-xs">
        {run.run?.aiCallCount !== undefined ? run.run?.aiCallCount : <span className="text-muted-foreground">–</span>}
      </TableCell>}
      {isCol("duration") && <TableCell className="font-mono text-xs">
        {(() => {
          const totalDuration = run.run?.turns?.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
          return totalDuration ? formatDuration(totalDuration) : <span className="text-muted-foreground">–</span>;
        })()}
      </TableCell>}
      {isCol("tokens") && <TableCell className="font-mono text-xs">
        {(() => {
          const usage = run.run?.tokenUsage
            ?? (run.run?.turns?.some(t => t.tokenUsage)
              ? run.run?.turns!.reduce(
                  (acc, t) => {
                    if (!t.tokenUsage) return acc;
                    return {
                      promptTokens: acc.promptTokens + t.tokenUsage.promptTokens,
                      completionTokens: acc.completionTokens + t.tokenUsage.completionTokens,
                      totalTokens: acc.totalTokens + t.tokenUsage.totalTokens,
                    };
                  },
                  { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
                )
              : undefined);
          return usage
            ? <>{usage.promptTokens.toLocaleString()}↑ · {usage.completionTokens.toLocaleString()}↓</>
            : <span className="text-muted-foreground">–</span>;
        })()}
      </TableCell>}
      {isCol("created") && <TableCell className="text-xs text-muted-foreground">
        {formatDate(run.createdAt)}
      </TableCell>}
      <TableCell className="text-right sticky right-0 z-10 bg-background group-hover:bg-muted/50 group-data-[state=selected]:bg-muted shadow-sm">
        <div className="flex items-center justify-end gap-1">
          <Link to={`/runs/${run._id}`}>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Eye className="h-4 w-4" />
            </Button>
          </Link>
          {run.run?.turns && run.run?.turns.some(t => t.snapshotUrl) && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Download archive"
              onClick={() => window.open(api.archiveUrl(run._id), "_blank")}
            >
              <Download className="h-4 w-4" />
            </Button>
          )}
          {((run.run?.status ?? "pending") === "pending" || run.run?.status === "queued") && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Pause"
              onClick={() => pauseMutation.mutate(run._id)}
              disabled={pauseMutation.isPending}
            >
              <Pause className="h-4 w-4" />
            </Button>
          )}
          {run.run?.status === "paused" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Resume"
              onClick={() => resumeMutation.mutate(run._id)}
              disabled={resumeMutation.isPending}
            >
              <Play className="h-4 w-4" />
            </Button>
          )}
          {((run.run?.status ?? "pending") === "pending" || run.run?.status === "paused") && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" title="Set priority">
                  <ArrowUpDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuLabel>Set Priority</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {[10, 5, 0, -5, -10].map((p) => (
                  <DropdownMenuCheckboxItem
                    key={p}
                    checked={(run.priority ?? 0) === p}
                    onCheckedChange={() => setPriorityMutation.mutate({ id: run._id, priority: p })}
                  >
                    {p > 0 ? `+${p}` : p} {p === 0 ? "(default)" : p > 0 ? "(higher)" : "(lower)"}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {run.run?.status === "done" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Retry"
              onClick={() => retryMutation.mutate(run._id)}
              disabled={retryMutation.isPending}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          )}
          <DeleteRunButton
            runId={run._id}
            onDelete={() => deleteMutation.mutate(run._id)}
            isDeleting={deleteMutation.isPending}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={isExpanded ? "Collapse details" : "Expand details"}
            onClick={() => setIsExpanded((v) => !v)}
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
          </Button>
        </div>
      </TableCell>
    </TableRow>
    {isExpanded && (
      <TableRow className="bg-muted/30 hover:bg-muted/30">
        <TableCell colSpan={visibleColumns.length + 2} className="px-6 py-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 text-sm">
            {run.scenario?.task && (
              <div className="sm:col-span-2 lg:col-span-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Task</p>
                <p className="text-sm whitespace-pre-wrap">{run.scenario.task}</p>
              </div>
            )}
            {run.scenario?.criteria && run.scenario.criteria.length > 0 && (
              <div className="sm:col-span-2 lg:col-span-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Criteria</p>
                <div className="flex flex-wrap gap-1">
                  {run.scenario.criteria.map((criterionId) => {
                    if (!isDone || !criteriaResultsMap) {
                      return (
                        <Link key={criterionId} to={`/criteria/${criterionId}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
                          {criterionId}
                        </Link>
                      );
                    }
                    const result = criteriaResultsMap.get(criterionId);
                    const { colorClass, Icon } = criterionResultStyle(result);
                    return (
                      <Link key={criterionId} to={`/criteria/${criterionId}`} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-mono hover:opacity-80 transition-opacity ${colorClass}`}>
                        <Icon className="h-3 w-3 shrink-0" />
                        {criterionId}
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Worker / Model</p>
              <p className="font-mono text-xs">{run.workerType}</p>
              {run.model && <p className="font-mono text-xs text-muted-foreground">{run.model}</p>}
              {run.agentVersion && <p className="font-mono text-xs text-muted-foreground">v{run.agentVersion}</p>}
            </div>
            {run.skillRevisions && run.skillRevisions.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Skills</p>
                <div className="flex flex-wrap gap-1">
                  {run.skillRevisions.map((ref) => {
                    const skillName = ref.split("@")[0].split("/").pop() ?? ref;
                    const skillSlug = ref.split("@")[0];
                    return (
                      <Tooltip key={ref}>
                        <TooltipTrigger asChild>
                          <Link to={`/skills/${skillSlug}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
                            {truncate(skillName, 20)}
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">{ref}</TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            )}
            {run.extensions && run.extensions.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Extensions</p>
                <div className="flex flex-wrap gap-1">
                  {run.extensions.map((id) => {
                    const [qualifiedName, version] = id.split("@");
                    const shortName = qualifiedName.split(".").pop() ?? id;
                    const extensionLabel = `${shortName}${version ? `@${version}` : ""}`;
                    return (
                      <Tooltip key={id}>
                        <TooltipTrigger asChild>
                          <Link to={`/extensions/${qualifiedName}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
                            {truncate(extensionLabel, 20)}
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">{id}</TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            )}
            {run.mcpServers && run.mcpServers.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">MCP Servers</p>
                <div className="flex flex-wrap gap-1">
                  {run.mcpServers.map((slug) => (
                    <Link key={slug} to={`/mcp-servers/${slug}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
                      {slug}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </TableCell>
      </TableRow>
    )}
  </>
  );
}

function GroupRows({
  group,
  isExpanded,
  onToggleExpand,
  selectedIds,
  onToggleSelect,
  reportSummaries,
  deleteMutation,
  retryMutation,
  pauseMutation,
  resumeMutation,
  setPriorityMutation,
  groupBy,
  profileNameMap,
  workerFilter,
  statusFilter,
  outcomeFilter,
  criteriaState,
  hiddenColumns,
}: {
  group: RunGroup;
  isExpanded: boolean;
  onToggleExpand: () => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  reportSummaries: BulkReportSummary | undefined;
  deleteMutation: { mutate: (id: string) => void; isPending: boolean };
  retryMutation: { mutate: (id: string) => void; isPending: boolean };
  pauseMutation: { mutate: (id: string) => void; isPending: boolean };
  resumeMutation: { mutate: (id: string) => void; isPending: boolean };
  setPriorityMutation: { mutate: (args: { id: string; priority: number }) => void; isPending: boolean };
  groupBy: GroupByKey;
  profileNameMap: Map<string, string>;
  workerFilter?: string;
  statusFilter?: string;
  outcomeFilter?: string;
  criteriaState?: string;
  hiddenColumns: Set<ColumnId>;
}) {
  const { aggregates, uniform } = group;
  const fmtDur = (v: number) => formatDuration(Math.round(v));
  const fmtNum = (v: number) => Math.round(v).toLocaleString();
  const isCol = (col: ColumnId) => !hiddenColumns.has(col);

  // Fetch runs for this group on expand
  const expandFilter = useMemo(() => {
    const opts: Record<string, string | undefined> = { worker: workerFilter, status: statusFilter, outcome: outcomeFilter, criteria: criteriaState };
    if (groupBy === "task") {
      // group.key is taskPromptId (or scenario.task fallback)
      opts.taskPromptId = group.key;
    } else if (groupBy === "profile") {
      opts.profileId = group.key === "no-profile" ? undefined : group.key;
    } else {
      opts.submissionId = group.key === "no-submission" ? undefined : group.key;
    }
    return opts;
  }, [group.key, groupBy, workerFilter, statusFilter, outcomeFilter, criteriaState]);

  const { data: expandedRunsResponse, isLoading: isExpandLoading } = useQuery({
    queryKey: ["group-runs", group.key, groupBy, workerFilter, statusFilter, outcomeFilter, criteriaState],
    queryFn: () => api.listRuns(expandFilter),
    enabled: isExpanded,
    refetchInterval: 10_000,
  });
  const expandedRuns = expandedRunsResponse?.data ?? [];

  // Group-level checkbox: select/deselect all runs in this group (runIds from server)
  const groupRunIds = group.runIds;
  const allGroupSelected = groupRunIds.length > 0 && groupRunIds.every((id) => selectedIds.has(id));
  const someGroupSelected = groupRunIds.some((id) => selectedIds.has(id));
  const handleToggleGroupSelect = () => {
    if (allGroupSelected) {
      groupRunIds.forEach((id) => onToggleSelect(id));
    } else {
      groupRunIds.filter((id) => !selectedIds.has(id)).forEach((id) => onToggleSelect(id));
    }
  };

  // Fetch report summaries for all runs in this group (always available via runIds)
  const { data: groupReportSummaries } = useQuery({
    queryKey: ["report-summaries", groupRunIds],
    queryFn: () => api.bulkReportSummary(groupRunIds),
    enabled: groupRunIds.length > 0,
    refetchInterval: 10_000,
  });
  // Merge parent-level and group-level summaries
  const mergedReportSummaries = useMemo(() => {
    if (!reportSummaries && !groupReportSummaries) return undefined;
    return { ...reportSummaries, ...groupReportSummaries };
  }, [reportSummaries, groupReportSummaries]);

  return (
    <>
      <TableRow
        className="group bg-background hover:bg-muted/50 cursor-pointer"
        onClick={onToggleExpand}
      >
        {/* Checkbox */}
        <TableCell onClick={(e) => e.stopPropagation()} className="w-[40px] min-w-[40px] sticky left-0 z-20 bg-background group-hover:bg-muted/50 shadow-sm">
          <Checkbox
            checked={allGroupSelected ? true : someGroupSelected ? "indeterminate" : false}
            onCheckedChange={handleToggleGroupSelect}
            aria-label={`Select all in group ${group.label}`}
          />
        </TableCell>
        {/* ID */}
        {isCol("id") && <TableCell className="font-medium sticky left-[40px] z-10 bg-background group-hover:bg-muted/50 border-r shadow-sm">
          <div className="flex items-center gap-2">
            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <span>{aggregates.count} run{aggregates.count !== 1 ? "s" : ""}</span>
          </div>
        </TableCell>}
        {/* Submission */}
        {isCol("submission") && <TableCell className="font-mono text-xs">
          {groupBy === "submissionId" ? (
            group.key !== "no-submission" ? (
              <Link
                to={`/runs?submissionId=${group.key}`}
                className="text-primary hover:underline font-medium"
                title={group.key}
                onClick={(e) => e.stopPropagation()}
              >
                {formatId(group.key)}
              </Link>
            ) : <span className="font-medium text-muted-foreground">{group.label}</span>
          ) : uniform.submissionId ? (
            <Link
              to={`/runs?submissionId=${uniform.submissionId}`}
              className="text-primary hover:underline"
              title={uniform.submissionId}
              onClick={(e) => e.stopPropagation()}
            >
              {formatId(uniform.submissionId)}
            </Link>
          ) : <span className="text-muted-foreground">–</span>}
        </TableCell>}
        {/* Task */}
        {isCol("task") && <TableCell className="max-w-[300px]">
          {groupBy === "task" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="font-medium cursor-default">{truncate(group.label, 60)}</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm whitespace-pre-wrap text-xs">{group.label}</TooltipContent>
            </Tooltip>
          ) : uniform.task ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default">{truncate(uniform.task, 60)}</span>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm whitespace-pre-wrap text-xs">{uniform.task}</TooltipContent>
            </Tooltip>
          ) : <span className="text-muted-foreground">–</span>}
        </TableCell>}
        {/* Criteria */}
        {isCol("criteria") && <TableCell>
          <span className="text-muted-foreground">–</span>
        </TableCell>}
        {/* Worker */}
        {isCol("worker") && <TableCell className="max-w-[200px]">
          {uniform.workerType ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="font-mono text-xs truncate block cursor-default">{uniform.workerType}</span>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{uniform.workerType}</TooltipContent>
              </Tooltip>
              {uniform.model && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="block font-mono text-xs text-muted-foreground truncate cursor-default">{uniform.model}</span>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">{uniform.model}</TooltipContent>
                </Tooltip>
              )}
            </>
          ) : <span className="text-xs text-muted-foreground">–</span>}
        </TableCell>}
        {/* Version */}
        {isCol("version") && <TableCell className="max-w-[120px]">
          {uniform.agentVersion ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="font-mono text-xs truncate block cursor-default">{uniform.agentVersion}</span>
              </TooltipTrigger>
              <TooltipContent className="text-xs">{uniform.agentVersion}</TooltipContent>
            </Tooltip>
          ) : <span className="text-xs text-muted-foreground">–</span>}
        </TableCell>}
        {/* Platform */}
        {isCol("os") && <TableCell className="text-center">
          {uniform.platform ? (
            <PlatformIcon platform={uniform.platform} className="h-4 w-4 inline-block" />
          ) : <span className="text-xs text-muted-foreground">–</span>}
        </TableCell>}
        {/* MCP */}
        {isCol("mcp") && <TableCell onClick={(e) => e.stopPropagation()}>
          {uniform.mcpServers && uniform.mcpServers.length > 0 ? (
            <OverflowBadges
              items={uniform.mcpServers}
              max={1}
              renderItem={(slug) => (
                <Tooltip key={slug}>
                  <TooltipTrigger asChild>
                    <Link to={`/mcp-servers/${slug}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
                      {slug}
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">{slug}</TooltipContent>
                </Tooltip>
              )}
              renderMenuItem={(slug) => (
                <DropdownMenuItem key={slug} asChild>
                  <Link to={`/mcp-servers/${slug}`} className="font-mono text-xs">{slug}</Link>
                </DropdownMenuItem>
              )}
            />
          ) : <span className="text-xs text-muted-foreground">–</span>}
        </TableCell>}
        {/* Skills */}
        {isCol("skills") && <TableCell onClick={(e) => e.stopPropagation()}>
          {uniform.skillRevisions && uniform.skillRevisions.length > 0 ? (
            <OverflowBadges
              items={uniform.skillRevisions}
              max={1}
              renderItem={(ref) => {
                const skillName = ref.split("@")[0].split("/").pop() ?? ref;
                const skillSlug = ref.split("@")[0];
                return (
                  <Tooltip key={ref}>
                    <TooltipTrigger asChild>
                      <Link to={`/skills/${skillSlug}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
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
                    <Link to={`/skills/${skillSlug}`} className="font-mono text-xs">{skillName}</Link>
                  </DropdownMenuItem>
                );
              }}
            />
          ) : <span className="text-xs text-muted-foreground">–</span>}
        </TableCell>}
        {/* Extensions */}
        {isCol("extensions") && <TableCell onClick={(e) => e.stopPropagation()}>
          {uniform.extensions && uniform.extensions.length > 0 ? (
            <OverflowBadges
              items={uniform.extensions}
              max={1}
              renderItem={(id) => {
                const [qualifiedName, version] = id.split("@");
                const shortName = qualifiedName.split(".").pop() ?? id;
                const extensionLabel = `${shortName}${version ? `@${version}` : ""}`;
                return (
                  <Tooltip key={id}>
                    <TooltipTrigger asChild>
                      <Link to={`/extensions/${qualifiedName}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
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
                    <Link to={`/extensions/${qualifiedName}`} className="font-mono text-xs">{truncate(extensionLabel, 20)}</Link>
                  </DropdownMenuItem>
                );
              }}
            />
          ) : <span className="text-xs text-muted-foreground">–</span>}
        </TableCell>}
        {/* Profile */}
        {isCol("profile") && <TableCell>
          {groupBy === "profile" ? (
            group.key !== "no-profile" ? (
              <Link
                to={`/profiles/${group.key}`}
                className="text-primary hover:underline font-medium"
                onClick={(e) => e.stopPropagation()}
              >
                {profileNameMap.get(group.key) ?? formatId(group.key)}
              </Link>
            ) : <span className="font-medium text-muted-foreground">{group.label}</span>
          ) : null}
        </TableCell>}
        {isCol("priority") && <TableCell />}
        {/* Status */}
        {isCol("status") && <TableCell>
          {(() => {
            const statusColors: Record<string, string> = {
              pending: "bg-gray-500",
              queued: "bg-purple-500",
              processing: "bg-blue-500",
              paused: "bg-amber-500",
              done: "bg-green-500",
            };
            const total = aggregates.count;
            const done = aggregates.statusCounts?.done ?? 0;
            const segments = Object.entries(aggregates.statusCounts ?? {}).filter(([, c]) => c > 0);
            return (
              <div className="flex flex-col gap-1 min-w-[80px]">
                <span className="text-xs font-medium">{done}/{total} done</span>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden flex">
                  {segments.map(([status, count]) => (
                    <div
                      key={status}
                      className={`h-full ${statusColors[status] ?? "bg-gray-400"} transition-all`}
                      style={{ width: `${(count / total) * 100}%` }}
                      title={`${status}: ${count}`}
                    />
                  ))}
                </div>
              </div>
            );
          })()}
        </TableCell>}
        {/* Outcome */}
        {isCol("outcome") && <TableCell>
          {(() => {
            const outcomeColors: Record<string, string> = {
              succeeded: "bg-green-500",
              failed: "bg-red-500",
              finished: "bg-yellow-500",
            };
            const doneCount = aggregates.statusCounts?.done ?? 0;
            const segments = Object.entries(aggregates.outcomeCounts ?? {}).filter(([, c]) => c > 0);
            if (doneCount === 0 || segments.length === 0) return <span className="text-xs text-muted-foreground">–</span>;
            const succeeded = aggregates.outcomeCounts?.succeeded ?? 0;
            return (
              <div className="flex flex-col gap-1 min-w-[80px]">
                <span className="text-xs font-medium">{succeeded}/{doneCount} pass</span>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden flex">
                  {segments.map(([outcome, count]) => (
                    <div
                      key={outcome}
                      className={`h-full ${outcomeColors[outcome] ?? "bg-gray-400"} transition-all`}
                      style={{ width: `${(count / doneCount) * 100}%` }}
                      title={`${outcome}: ${count}`}
                    />
                  ))}
                </div>
              </div>
            );
          })()}
        </TableCell>}
        {/* Report */}
        {isCol("report") && <TableCell>
          {(() => {
            if (!mergedReportSummaries || groupRunIds.length === 0) return <span className="text-xs text-muted-foreground">–</span>;
            let total = 0, completed = 0, pending = 0, generating = 0, failed = 0;
            for (const id of groupRunIds) {
              const s = mergedReportSummaries[id];
              if (!s) continue;
              total += s.total;
              completed += s.completed;
              pending += s.pending;
              generating += s.generating;
              failed += s.failed;
            }
            if (total === 0) return <span className="text-xs text-muted-foreground">–</span>;
            return <ReportProgressBar summary={{ total, completed, pending, generating, failed }} />;
          })()}
        </TableCell>}
        {/* Attempt */}
        {isCol("attempt") && <TableCell />}
        {/* Turns */}
        {isCol("turns") && <TableCell className="text-center font-mono text-xs">
          {aggregates.turns
            ? formatStatRange(aggregates.turns, fmtNum)
            : <span className="text-muted-foreground">–</span>}
        </TableCell>}
        {/* LLM Calls */}
        {isCol("llmCalls") && <TableCell className="text-center font-mono text-xs">
          {aggregates.llmCalls
            ? formatStatRange(aggregates.llmCalls, fmtNum)
            : <span className="text-muted-foreground">–</span>}
        </TableCell>}
        {/* Duration */}
        {isCol("duration") && <TableCell className="font-mono text-xs">
          {formatStatRange(aggregates.duration, fmtDur)}
        </TableCell>}
        {/* Tokens */}
        {isCol("tokens") && <TableCell className="font-mono text-xs">
          {aggregates.promptTokens || aggregates.completionTokens
            ? <>{aggregates.promptTokens ? <>{formatStatRange(aggregates.promptTokens, fmtNum)}↑</> : null}{aggregates.promptTokens && aggregates.completionTokens ? " · " : null}{aggregates.completionTokens ? <>{formatStatRange(aggregates.completionTokens, fmtNum)}↓</> : null}</>
            : <span className="text-muted-foreground">–</span>}
        </TableCell>}
        {/* Created */}
        {isCol("created") && <TableCell />}
        {/* Actions */}
        <TableCell className="sticky right-0 z-10 bg-background group-hover:bg-muted/50 border-l shadow-sm" />
      </TableRow>
      {isExpanded && (
        isExpandLoading ? (
          <TableRow>
            <TableCell colSpan={20} className="text-center py-4">
              <RefreshCw className="h-4 w-4 animate-spin inline-block mr-2" />
              Loading runs…
            </TableCell>
          </TableRow>
        ) : (
          expandedRuns.map((run) => (
            <RunRow
              key={run._id}
              run={run}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
              reportSummaries={mergedReportSummaries}
              deleteMutation={deleteMutation}
              retryMutation={retryMutation}
              pauseMutation={pauseMutation}
              resumeMutation={resumeMutation}
              setPriorityMutation={setPriorityMutation}
              profileNameMap={profileNameMap}
              hiddenColumns={hiddenColumns}
            />
          ))
        )
      )}
    </>
  );
}

const REPORT_COLORS: Record<string, string> = {
  pending: "bg-gray-500",
  generating: "bg-blue-500",
  completed: "bg-green-500",
  failed: "bg-red-500",
};

function ReportProgressBar({ summary }: { summary: { total: number; pending: number; generating: number; completed: number; failed: number } }) {
  const { total, completed, generating, pending, failed } = summary;
  const segments = [
    { status: "completed", count: completed },
    { status: "generating", count: generating },
    { status: "pending", count: pending },
    { status: "failed", count: failed },
  ].filter((s) => s.count > 0);
  return (
    <div className="flex flex-col gap-1 min-w-[80px]">
      <span className="text-xs font-medium">{completed}/{total} done</span>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden flex">
        {segments.map(({ status, count }) => (
          <div
            key={status}
            className={`h-full ${REPORT_COLORS[status] ?? "bg-gray-400"} transition-all`}
            style={{ width: `${(count / total) * 100}%` }}
            title={`${status}: ${count}`}
          />
        ))}
      </div>
    </div>
  );
}

function DeleteRunButton({
  runId,
  onDelete,
  isDeleting,
}: {
  runId: string;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive">
          <Trash2 className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete run?</AlertDialogTitle>
          <AlertDialogDescription>
            This will soft-delete run <code className="font-mono">{formatId(runId)}</code>.
            It can be recovered later if needed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onDelete} disabled={isDeleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            {isDeleting ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
