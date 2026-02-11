// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { Trash2, Eye, Plus, RefreshCw } from "lucide-react";
import { formatDate, formatId, truncate } from "@/lib/utils";
import { WORKER_TYPES, STATUS_LIST } from "@/types";
import type { Run } from "@/types";

export function RunsList() {
  const [workerFilter, setWorkerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const queryClient = useQueryClient();

  const { data: runs = [], isLoading, isRefetching } = useQuery({
    queryKey: ["runs", workerFilter],
    queryFn: () => api.listRuns(workerFilter === "all" ? undefined : workerFilter),
    refetchInterval: 10_000,
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteRun,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["runs"] }),
  });

  const filteredRuns =
    statusFilter === "all" ? runs : runs.filter((r) => r.status === statusFilter);

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
          <Select value={workerFilter} onValueChange={setWorkerFilter}>
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
        <div className="flex-1" />
        {isRefetching && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
        <span className="text-sm text-muted-foreground">
          {filteredRuns.length} run{filteredRuns.length !== 1 ? "s" : ""}
        </span>
      </div>

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
              <TableHead className="w-[100px]">ID</TableHead>
              <TableHead>Task</TableHead>
              <TableHead className="w-[180px]">Worker</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
              <TableHead className="w-[80px]">Turns</TableHead>
              <TableHead className="w-[160px]">Created</TableHead>
              <TableHead className="w-[100px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRuns.map((run: Run) => (
              <TableRow key={run._id}>
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
                </TableCell>
                <TableCell>
                  <StatusBadge status={run.status} />
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
