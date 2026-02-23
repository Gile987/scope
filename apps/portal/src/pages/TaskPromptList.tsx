// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Eye, Search, RefreshCw, Plus, List } from "lucide-react";
import { formatDate, formatId, truncate } from "@/lib/utils";
import { TaskPromptFeatures } from "@/components/TaskPromptFeatures";
import type { TaskPrompt } from "@/types";

export function TaskPromptList() {
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogStep, setDialogStep] = useState<1 | 2>(1);
  const [newText, setNewText] = useState("");
  const [createdPrompt, setCreatedPrompt] = useState<TaskPrompt | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading, isRefetching } = useQuery({
    queryKey: ["task-prompts", search],
    queryFn: () => api.listTaskPrompts({ search: search || undefined }),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const deleteMutation = useMutation({
    mutationFn: api.deleteTaskPrompt,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task-prompts"] }),
  });

  const createMutation = useMutation({
    mutationFn: (text: string) => api.createTaskPrompt(text),
    onSuccess: (prompt) => {
      queryClient.invalidateQueries({ queryKey: ["task-prompts"] });
      setCreatedPrompt(prompt);
      setDialogStep(2);
    },
  });

  const resetDialog = () => {
    setDialogOpen(false);
    setDialogStep(1);
    setNewText("");
    setCreatedPrompt(null);
  };

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Task Prompts</h1>
          <p className="text-muted-foreground">
            Browse and manage content-addressed task prompt entities
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) resetDialog(); else setDialogOpen(true); }}>
          <DialogTrigger asChild>
            <Button className="gap-1.5">
              <Plus className="h-4 w-4" /> New Task Prompt
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            {dialogStep === 1 ? (
              <>
                <DialogHeader>
                  <DialogTitle>New Task Prompt</DialogTitle>
                  <DialogDescription>
                    Enter the task text below. If a task prompt with the same text already exists,
                    the existing one is returned (content-addressed).
                  </DialogDescription>
                </DialogHeader>
                <Textarea
                  placeholder="Enter task prompt text…"
                  value={newText}
                  onChange={(e) => setNewText(e.target.value)}
                  rows={8}
                  className="font-mono text-sm"
                />
                <DialogFooter>
                  <Button
                    onClick={() => createMutation.mutate(newText)}
                    disabled={!newText.trim() || createMutation.isPending}
                  >
                    {createMutation.isPending ? "Creating…" : "Create"}
                  </Button>
                </DialogFooter>
              </>
            ) : createdPrompt ? (
              <>
                <DialogHeader>
                  <DialogTitle>Task Prompt Created</DialogTitle>
                  <DialogDescription>
                    <span className="font-mono text-xs select-all">{createdPrompt._id}</span>
                  </DialogDescription>
                </DialogHeader>
                <pre className="whitespace-pre-wrap text-sm bg-muted p-3 rounded-md font-mono leading-relaxed max-h-[150px] overflow-y-auto">
                  {createdPrompt.text}
                </pre>
                <TaskPromptFeatures taskPromptId={createdPrompt._id} autoExtract />
                <DialogFooter className="gap-2 sm:gap-0">
                  <Button variant="outline" onClick={resetDialog}>
                    Done
                  </Button>
                  <Button onClick={() => { resetDialog(); navigate(`/task-prompts/${createdPrompt._id}`); }}>
                    View Details
                  </Button>
                </DialogFooter>
              </>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 max-w-sm">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search task prompts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9"
        />
        {isRefetching && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {search ? "No task prompts match your search" : "No task prompts registered yet"}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">ID</TableHead>
                <TableHead>Text</TableHead>
                <TableHead className="w-[100px]">Features</TableHead>
                <TableHead className="w-[160px]">Created</TableHead>
                <TableHead className="w-[120px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((tp) => (
                <TableRow key={tp._id}>
                  <TableCell>
                    <Link
                      to={`/task-prompts/${tp._id}`}
                      className="font-mono text-xs font-medium hover:underline"
                    >
                      {formatId(tp._id)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[400px]">
                    {truncate(tp.text, 80)}
                  </TableCell>
                  <TableCell>
                    {tp.features ? (
                      <Badge variant="secondary" className="text-xs">
                        {tp.features.filter((f) => f.detected).length}/{tp.features.length}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(tp.createdAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      <Link to={`/task-prompts/${tp._id}`}>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Eye className="h-4 w-4" />
                        </Button>
                      </Link>
                      <Link to={`/runs?taskPromptId=${encodeURIComponent(tp._id)}`}>
                        <Button variant="ghost" size="icon" className="h-8 w-8" title="View runs for this task prompt">
                          <List className="h-4 w-4" />
                        </Button>
                      </Link>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete task prompt?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will soft-delete task prompt{" "}
                              <code className="font-mono">{formatId(tp._id)}</code>.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteMutation.mutate(tp._id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {!isLoading && (
        <p className="text-sm text-muted-foreground">
          {total} task prompt{total !== 1 ? "s" : ""} total
        </p>
      )}
    </div>
  );
}
