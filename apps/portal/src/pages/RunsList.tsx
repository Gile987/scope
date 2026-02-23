// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
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
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { ReportStatusBadge } from "@/components/ReportStatusBadge";
import { Trash2, Eye, Plus, RefreshCw, Repeat, FileText } from "lucide-react";
import { formatDate, formatId, truncate } from "@/lib/utils";
import { WORKER_TYPES, STATUS_LIST } from "@/types";
import type { Run, BulkResubmitOverrides, McpServerDocument } from "@/types";

export function RunsList() {
  const [workerFilter, setWorkerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [taskFilter, setTaskFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [resubmitCount, setResubmitCount] = useState(1);
  const [resubmitDialogOpen, setResubmitDialogOpen] = useState(false);
  const [resubmitOverrides, setResubmitOverrides] = useState<BulkResubmitOverrides>({});
  const queryClient = useQueryClient();

  const { data: runs = [], isLoading, isRefetching } = useQuery({
    queryKey: ["runs", workerFilter],
    queryFn: () => api.listRuns(workerFilter === "all" ? undefined : workerFilter),
    refetchInterval: 10_000,
  });

  // Fetch MCP servers for the resubmit dialog
  const { data: mcpServers = [] } = useQuery<McpServerDocument[]>({
    queryKey: ["mcp-servers"],
    queryFn: api.listMcpServers,
  });

  // Fetch bulk report status for all visible runs
  const runIds = useMemo(() => runs.map((r) => r._id), [runs]);
  const { data: reportStatuses } = useQuery({
    queryKey: ["report-statuses", runIds],
    queryFn: () => api.bulkReportStatus(runIds),
    enabled: runIds.length > 0,
    refetchInterval: 10_000,
  });

  const uniqueTasks = useMemo(
    () => [...new Set(runs.map((r) => r.scenario?.task).filter(Boolean) as string[])].sort(),
    [runs],
  );

  // Compute summary of selected runs' values for the resubmit dialog
  const selectedRunsSummary = useMemo(() => {
    const selected = runs.filter((r) => selectedIds.has(r._id));
    if (selected.length === 0) return { worker: null, model: null, maxIterations: null, mcpServers: null };

    const workers = [...new Set(selected.map((r) => r.workerType))];
    const models = [...new Set(selected.map((r) => r.model ?? ""))];
    const iterations = [...new Set(selected.map((r) => r.maxIterations ?? 0))];
    const mcpSets = selected.map((r) => (r.mcpServers ?? []).sort().join(","));
    const uniqueMcp = [...new Set(mcpSets)];

    return {
      worker: workers.length === 1 ? workers[0] : null,
      model: models.length === 1 ? (models[0] || null) : null,
      maxIterations: iterations.length === 1 ? (iterations[0] || null) : null,
      mcpServers: uniqueMcp.length === 1 ? (selected[0].mcpServers ?? []) : null,
      isMultiWorker: workers.length > 1,
      isMultiModel: models.length > 1,
      isMultiIterations: iterations.length > 1,
      isMultiMcp: uniqueMcp.length > 1,
    };
  }, [runs, selectedIds]);

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
    mutationFn: (ids: string[]) => api.bulkCreateReports(ids),
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

  const filteredRuns = runs.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (taskFilter !== "all" && r.scenario?.task !== taskFilter) return false;
    return true;
  });

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
          <Select value={workerFilter} onValueChange={(v) => { setWorkerFilter(v); setTaskFilter("all"); }}>
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
          <Select value={statusFilter} onValueChange={setStatusFilter}>
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
          <span className="text-sm text-muted-foreground">Task:</span>
          <Select value={taskFilter} onValueChange={setTaskFilter}>
            <SelectTrigger className="w-[260px]">
              <SelectValue placeholder="All tasks" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tasks</SelectItem>
              {uniqueTasks.map((t) => (
                <SelectItem key={t} value={t}>
                  <span title={t}>{truncate(t, 50)}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1" />
        {isRefetching && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
        <span className="text-sm text-muted-foreground">
          {filteredRuns.length} run{filteredRuns.length !== 1 ? "s" : ""}
        </span>
      </div>

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

                  {/* Worker type override */}
                  <div className="flex items-center gap-4 mb-3">
                    <Label className="text-sm w-32 shrink-0">Worker</Label>
                    <Select
                      value={resubmitOverrides.workerType ?? "__keep__"}
                      onValueChange={(v) => setResubmitOverrides((prev) => {
                        const next = { ...prev };
                        if (v === "__keep__") { delete next.workerType; } else { next.workerType = v; }
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
                        {WORKER_TYPES.map((w) => (
                          <SelectItem key={w} value={w}>{w}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Model override */}
                  <div className="flex items-center gap-4 mb-3">
                    <Label className="text-sm w-32 shrink-0">Model</Label>
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
                        <SelectItem value="gpt-4.1">gpt-4.1</SelectItem>
                        <SelectItem value="gpt-4.1-mini">gpt-4.1-mini</SelectItem>
                        <SelectItem value="gpt-4.1-nano">gpt-4.1-nano</SelectItem>
                        <SelectItem value="o4-mini">o4-mini</SelectItem>
                        <SelectItem value="claude-sonnet-4-20250514">claude-sonnet-4-20250514</SelectItem>
                        <SelectItem value="claude-opus-4-20250514">claude-opus-4-20250514</SelectItem>
                      </SelectContent>
                    </Select>
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
                        {[1, 2, 3, 5, 10, 15, 20].map((n) => (
                          <SelectItem key={n} value={n.toString()}>{n}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* MCP servers override */}
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
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : filteredRuns.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No runs found. <Link to="/runs/new" className="text-primary underline">Submit one?</Link>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <Checkbox
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all"
                />
              </TableHead>
              <TableHead className="w-[100px]">ID</TableHead>
              <TableHead>Task</TableHead>
              <TableHead className="w-[180px]">Worker</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
              <TableHead className="w-[100px]">Report</TableHead>
              <TableHead className="w-[80px]">Turns</TableHead>
              <TableHead className="w-[160px]">Created</TableHead>
              <TableHead className="w-[100px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRuns.map((run: Run) => (
              <TableRow key={run._id} data-state={selectedIds.has(run._id) ? "selected" : undefined}>
                <TableCell>
                  <Checkbox
                    checked={selectedIds.has(run._id)}
                    onCheckedChange={() => toggleSelect(run._id)}
                    aria-label={`Select run ${formatId(run._id)}`}
                  />
                </TableCell>
                <TableCell className="font-mono text-xs">
                  <Link to={`/runs/${run._id}`} className="text-primary hover:underline">
                    {formatId(run._id)}
                  </Link>
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
                  <StatusBadge status={run.status} />
                </TableCell>
                <TableCell>
                  {reportStatuses?.[run._id] ? (
                    <Link to={`/reports/${reportStatuses[run._id].reportId}`}>
                      <ReportStatusBadge status={reportStatuses[run._id].status} />
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">–</span>
                  )}
                </TableCell>
                <TableCell className="text-center">
                  {run.turns?.length ?? "–"}
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
                    <DeleteRunButton
                      runId={run._id}
                      onDelete={() => deleteMutation.mutate(run._id)}
                      isDeleting={deleteMutation.isPending}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
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
