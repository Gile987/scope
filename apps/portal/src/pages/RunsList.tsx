// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, useCallback } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, OutcomeBadge } from "@/components/StatusBadge";
import { Trash2, Eye, Plus, RefreshCw, Repeat, FileText, X, Download, ChevronRight, ChevronDown, ChevronLeft, Lock } from "lucide-react";
import { formatDate, formatId, truncate, formatDuration } from "@/lib/utils";
import { WORKER_TYPES, STATUS_LIST, OUTCOME_LIST } from "@/types";
import type { Run, BulkResubmitOverrides, McpServerDocument, CodingAgent, BulkReportSummary, RunGroup, GroupByKey, ProfileWithVersion } from "@/types";
import { formatStatRange } from "@/lib/grouping";

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
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorDirection, setCursorDirection] = useState<"after" | "before" | undefined>(undefined);
  const queryClient = useQueryClient();

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

  // Filtering is now server-side via status, outcome, and taskPromptId query params
  const filteredRuns = runs;

  const runGroups = serverGroups;

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allSelected = filteredRuns.length > 0 && filteredRuns.every((r) => selectedIds.has(r._id));
  const someSelected = filteredRuns.some((r) => selectedIds.has(r._id));

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredRuns.map((r) => r._id)));
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

  return (
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
        <div className="flex-1" />
        {(isRefetching || isGroupsRefetching) && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
        <span className="text-sm text-muted-foreground">
          {groupBy !== "none"
            ? `${runGroups.length} group${runGroups.length !== 1 ? "s" : ""}`
            : `${filteredRuns.length} run${filteredRuns.length !== 1 ? "s" : ""}`}
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
        <div className="flex items-center gap-4 rounded-md border bg-muted/50 px-4 py-2">
          <span className="text-sm font-medium">
            {selectedIds.size} run{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <FileText className="h-4 w-4" /> Generate reports
              </Button>
            </AlertDialogTrigger>
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
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Repeat className="h-4 w-4" /> Re-submit selected
              </Button>
            </AlertDialogTrigger>
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
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="gap-1.5">
                <Trash2 className="h-4 w-4" /> Delete selected
              </Button>
            </AlertDialogTrigger>
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
        </div>
      )}

      {/* Table */}
      {(groupBy === "none" ? isLoading : isGroupsLoading) ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (groupBy === "none" && filteredRuns.length === 0) || (groupBy !== "none" && runGroups.length === 0) ? (
        <div className="text-center py-12 text-muted-foreground">
          No runs found. <Link to="/runs/new" className="text-primary underline">Submit one?</Link>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                {groupBy === "none" && (
                  <Checkbox
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all"
                  />
                )}
              </TableHead>
              <TableHead className="w-[100px]">ID</TableHead>
              <TableHead className="w-[100px]">Submission</TableHead>
              <TableHead>Task</TableHead>
              <TableHead className="w-[180px]">Worker</TableHead>
              <TableHead>Version</TableHead>
              <TableHead className="w-[80px]">OS</TableHead>
              <TableHead>MCP</TableHead>
              <TableHead>Skills</TableHead>
              <TableHead>Extensions</TableHead>
              <TableHead>Profile</TableHead>
              <TableHead className="w-[100px]">Status</TableHead>
              <TableHead className="w-[100px]">Outcome</TableHead>
              <TableHead className="w-[100px]">Report</TableHead>
              <TableHead className="w-[80px]">Turns</TableHead>
              <TableHead className="w-[80px]">LLM Calls</TableHead>
              <TableHead className="w-[100px]">Duration</TableHead>
              <TableHead className="w-[120px]">Tokens</TableHead>
              <TableHead className="w-[160px]">Created</TableHead>
              <TableHead className="w-[100px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groupBy !== "none" ? (
              runGroups.map((group) => {
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
                    groupBy={groupBy}
                    profileNameMap={profileNameMap}
                    workerFilter={workerFilter === "all" ? undefined : workerFilter}
                    statusFilter={effectiveStatus}
                    outcomeFilter={effectiveOutcome}
                    criteriaState={criteriaState}
                  />
                );
              })
            ) : (
              filteredRuns.map((run: Run) => (
                <RunRow
                  key={run._id}
                  run={run}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  reportSummaries={reportSummaries}
                  deleteMutation={deleteMutation}
                  profileNameMap={profileNameMap}
                />
              ))
            )}
          </TableBody>
        </Table>
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
  );
}

function RunRow({
  run,
  selectedIds,
  onToggleSelect,
  reportSummaries,
  deleteMutation,
  profileNameMap,
}: {
  run: Run;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  reportSummaries: BulkReportSummary | undefined;
  deleteMutation: { mutate: (id: string) => void; isPending: boolean };
  profileNameMap: Map<string, string>;
}) {
  return (
    <TableRow data-state={selectedIds.has(run._id) ? "selected" : undefined}>
      <TableCell>
        <Checkbox
          checked={selectedIds.has(run._id)}
          onCheckedChange={() => onToggleSelect(run._id)}
          aria-label={`Select run ${formatId(run._id)}`}
        />
      </TableCell>
      <TableCell className="font-mono text-xs">
        <Link to={`/runs/${run._id}`} className="text-primary hover:underline">
          {formatId(run._id)}
        </Link>
      </TableCell>
      <TableCell className="font-mono text-xs">
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
      </TableCell>
      <TableCell className="max-w-[300px]">
        <span title={run.scenario?.task ?? "–"}>{truncate(run.scenario?.task ?? "–", 60)}</span>
      </TableCell>
      <TableCell>
        <span className="font-mono text-xs">{run.workerType}</span>
        {run.model && (
          <span className="block font-mono text-xs text-muted-foreground">{run.model}</span>
        )}
      </TableCell>
      <TableCell>
        {run.agentVersion ? (
          <span className="font-mono text-xs">{run.agentVersion}</span>
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell className="text-center">
        {run.os ? (
          <PlatformIcon platform={run.os.platform} className="h-4 w-4 inline-block" />
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell>
        {run.mcpServers && run.mcpServers.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {run.mcpServers.map((slug) => (
              <Link key={slug} to={`/mcp-servers/${slug}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
                {slug}
              </Link>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell>
        {run.skillRevisions && run.skillRevisions.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {run.skillRevisions.map((ref) => {
              const skillName = ref.split("@")[0].split("/").pop() ?? ref;
              const skillSlug = ref.split("@")[0];
              return (
                <Link key={ref} to={`/skills/${skillSlug}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors" title={ref}>
                  {skillName}
                </Link>
              );
            })}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell>
        {run.extensions && run.extensions.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {run.extensions.map((id) => {
              const [qualifiedName, version] = id.split("@");
              const shortName = qualifiedName.split(".").pop() ?? id;
              return (
                <Link key={id} to={`/extensions/${qualifiedName}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors" title={id}>
                  {shortName}{version ? `@${version}` : ""}
                </Link>
              );
            })}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell>
        {run.profileId ? (
          <Link to={`/profiles/${run.profileId}`} className="text-primary hover:underline">
            {profileNameMap.get(run.profileId) ?? formatId(run.profileId)}
          </Link>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge status={run.status} />
      </TableCell>
      <TableCell>
        <OutcomeBadge outcome={run.outcome} />
      </TableCell>
      <TableCell>
        {reportSummaries?.[run._id] ? (
          <Link to={`/runs/${run._id}/reports`} className="block">
            <ReportProgressBar summary={reportSummaries[run._id]} />
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell className="text-center">
        {run.turns?.length ?? "–"}
      </TableCell>
      <TableCell className="text-center font-mono text-xs">
        {run.aiCallCount !== undefined ? run.aiCallCount : <span className="text-muted-foreground">–</span>}
      </TableCell>
      <TableCell className="font-mono text-xs">
        {(() => {
          const totalDuration = run.turns?.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
          return totalDuration ? formatDuration(totalDuration) : <span className="text-muted-foreground">–</span>;
        })()}
      </TableCell>
      <TableCell className="font-mono text-xs">
        {(() => {
          const usage = run.tokenUsage
            ?? (run.turns?.some(t => t.tokenUsage)
              ? run.turns!.reduce(
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
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatDate(run.createdAt)}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Link to={`/runs/${run._id}`}>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Eye className="h-4 w-4" />
            </Button>
          </Link>
          {run.turns && run.turns.some(t => t.snapshotUrl) && (
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
          <DeleteRunButton
            runId={run._id}
            onDelete={() => deleteMutation.mutate(run._id)}
            isDeleting={deleteMutation.isPending}
          />
        </div>
      </TableCell>
    </TableRow>
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
  groupBy,
  profileNameMap,
  workerFilter,
  statusFilter,
  outcomeFilter,
  criteriaState,
}: {
  group: RunGroup;
  isExpanded: boolean;
  onToggleExpand: () => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  reportSummaries: BulkReportSummary | undefined;
  deleteMutation: { mutate: (id: string) => void; isPending: boolean };
  groupBy: GroupByKey;
  profileNameMap: Map<string, string>;
  workerFilter?: string;
  statusFilter?: string;
  outcomeFilter?: string;
  criteriaState?: string;
}) {
  const { aggregates, uniform } = group;
  const fmtDur = (v: number) => formatDuration(Math.round(v));
  const fmtNum = (v: number) => Math.round(v).toLocaleString();

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
        className="bg-muted/50 hover:bg-muted/70 cursor-pointer"
        onClick={onToggleExpand}
      >
        {/* Checkbox */}
        <TableCell onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={allGroupSelected ? true : someGroupSelected ? "indeterminate" : false}
            onCheckedChange={handleToggleGroupSelect}
            aria-label={`Select all in group ${group.label}`}
          />
        </TableCell>
        {/* ID */}
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <span>{aggregates.count} run{aggregates.count !== 1 ? "s" : ""}</span>
          </div>
        </TableCell>
        {/* Submission */}
        <TableCell className="font-mono text-xs">
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
        </TableCell>
        {/* Task */}
        <TableCell className="max-w-[300px]">
          {groupBy === "task" ? (
            <span className="font-medium" title={group.label}>{truncate(group.label, 60)}</span>
          ) : uniform.task ? (
            <span title={uniform.task}>{truncate(uniform.task, 60)}</span>
          ) : <span className="text-muted-foreground">–</span>}
        </TableCell>
        {/* Worker */}
        <TableCell>
          {uniform.workerType ? (
            <>
              <span className="font-mono text-xs">{uniform.workerType}</span>
              {uniform.model && (
                <span className="block font-mono text-xs text-muted-foreground">{uniform.model}</span>
              )}
            </>
          ) : <span className="text-xs text-muted-foreground">–</span>}
        </TableCell>
        {/* Version */}
        <TableCell>
          {uniform.agentVersion ? (
            <span className="font-mono text-xs">{uniform.agentVersion}</span>
          ) : <span className="text-xs text-muted-foreground">–</span>}
        </TableCell>
        {/* Platform */}
        <TableCell className="text-center">
          {uniform.platform ? (
            <PlatformIcon platform={uniform.platform} className="h-4 w-4 inline-block" />
          ) : <span className="text-xs text-muted-foreground">–</span>}
        </TableCell>
        {/* MCP */}
        <TableCell>
          {uniform.mcpServers && uniform.mcpServers.length > 0 ? (
            <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
              {uniform.mcpServers.map((slug) => (
                <Link key={slug} to={`/mcp-servers/${slug}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
                  {slug}
                </Link>
              ))}
            </div>
          ) : <span className="text-xs text-muted-foreground">–</span>}
        </TableCell>
        {/* Skills */}
        <TableCell>
          {uniform.skillRevisions && uniform.skillRevisions.length > 0 ? (
            <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
              {uniform.skillRevisions.map((ref) => {
                const skillName = ref.split("@")[0].split("/").pop() ?? ref;
                const skillSlug = ref.split("@")[0];
                return (
                  <Link key={ref} to={`/skills/${skillSlug}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors" title={ref}>
                    {skillName}
                  </Link>
                );
              })}
            </div>
          ) : <span className="text-xs text-muted-foreground">–</span>}
        </TableCell>
        {/* Extensions */}
        <TableCell>
          {uniform.extensions && uniform.extensions.length > 0 ? (
            <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
              {uniform.extensions.map((id) => {
                const [qualifiedName, version] = id.split("@");
                const shortName = qualifiedName.split(".").pop() ?? id;
                return (
                  <Link key={id} to={`/extensions/${qualifiedName}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors" title={id}>
                    {shortName}{version ? `@${version}` : ""}
                  </Link>
                );
              })}
            </div>
          ) : <span className="text-xs text-muted-foreground">–</span>}
        </TableCell>
        {/* Profile */}
        <TableCell>
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
        </TableCell>
        {/* Status */}
        <TableCell>
          {(() => {
            const statusColors: Record<string, string> = {
              pending: "bg-gray-500",
              processing: "bg-blue-500",
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
        </TableCell>
        {/* Outcome */}
        <TableCell>
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
        </TableCell>
        {/* Report */}
        <TableCell>
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
        </TableCell>
        {/* Turns */}
        <TableCell className="text-center font-mono text-xs">
          {formatStatRange(aggregates.turns, fmtNum)}
        </TableCell>
        {/* LLM Calls */}
        <TableCell />
        {/* Duration */}
        <TableCell className="font-mono text-xs">
          {formatStatRange(aggregates.duration, fmtDur)}
        </TableCell>
        {/* Tokens */}
        <TableCell className="font-mono text-xs">
          {aggregates.promptTokens
            ? <>{formatStatRange(aggregates.promptTokens, fmtNum)}↑</>
            : <span className="text-muted-foreground">–</span>}
        </TableCell>
        {/* Created */}
        <TableCell />
        {/* Actions */}
        <TableCell />
      </TableRow>
      {isExpanded && (
        isExpandLoading ? (
          <TableRow>
            <TableCell colSpan={19} className="text-center py-4">
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
              profileNameMap={profileNameMap}
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
