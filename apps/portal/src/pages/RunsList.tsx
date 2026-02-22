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
import type { Run } from "@/types";

export function RunsList() {
  const [workerFilter, setWorkerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [taskFilter, setTaskFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [resubmitCount, setResubmitCount] = useState(1);
  const [resubmitDialogOpen, setResubmitDialogOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: runs = [], isLoading, isRefetching } = useQuery({
    queryKey: ["runs", workerFilter],
    queryFn: () => api.listRuns(workerFilter === "all" ? undefined : workerFilter),
    refetchInterval: 10_000,
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
    mutationFn: ({ ids, count }: { ids: string[]; count: number }) => api.bulkResubmitRuns(ids, count),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      setSelectedIds(new Set());
      setResubmitDialogOpen(false);
      setResubmitCount(1);
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
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Re-submit {selectedIds.size} run{selectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will create new runs with the same scenario, worker, and settings as the selected runs.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="py-4">
                <Label htmlFor="resubmit-count" className="text-sm font-medium">Copies per run</Label>
                <Input
                  id="resubmit-count"
                  type="number"
                  min={1}
                  max={10}
                  value={resubmitCount}
                  onChange={(e) => setResubmitCount(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                  className="mt-1.5 w-24"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Total new runs: {selectedIds.size * resubmitCount}
                </p>
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setResubmitCount(1)}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => bulkResubmitMutation.mutate({ ids: Array.from(selectedIds), count: resubmitCount })}
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
