// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Lightbulb, Trash2, Search, ThumbsUp, ThumbsDown, ShieldBan, ShieldCheck } from "lucide-react";
import { truncate, formatDate } from "@/lib/utils";

export function InsightsList() {
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();

  const { data: insights = [], isLoading } = useQuery({
    queryKey: ["insights", search],
    queryFn: () => api.listInsights(search || undefined),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteInsight,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["insights"] }),
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

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-5 w-80 mt-2" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Insights</h1>
          <p className="text-muted-foreground">
            Cross-cutting observations discovered during report analysis
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 max-w-sm">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search insights…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {insights.length > 0 ? (
        <>
          <div className="flex items-center justify-end">
            <span className="text-sm text-muted-foreground">{insights.length} insights</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead className="w-[120px]">Category</TableHead>
                <TableHead className="w-[100px]">Source</TableHead>
                <TableHead className="w-[100px] text-center">Refs</TableHead>
                <TableHead className="w-[120px] text-center">Votes</TableHead>
                <TableHead className="w-[80px] text-center">Status</TableHead>
                <TableHead className="w-[160px]">Created</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {insights.map((insight) => (
                <TableRow key={insight._id} className={insight.blocked ? "opacity-50" : ""}>
                  <TableCell>
                    <Link
                      to={`/insights/${insight._id}`}
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      {truncate(insight.title, 80)}
                    </Link>
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
                  </TableCell>
                  <TableCell>
                    {insight.category ? (
                      <Badge variant="secondary" className="text-xs">
                        {insight.category}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">–</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {insight.createdBy === "agent" ? "Agent" : "User"}
                  </TableCell>
                  <TableCell className="text-center text-sm">
                    {insight.referenceCount}
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex items-center justify-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => upvoteMutation.mutate(insight._id)}
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
                        onClick={() => downvoteMutation.mutate(insight._id)}
                        disabled={downvoteMutation.isPending}
                      >
                        <ThumbsDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => blockMutation.mutate({ id: insight._id, blocked: !insight.blocked })}
                      title={insight.blocked ? "Unblock" : "Block"}
                    >
                      {insight.blocked ? (
                        <ShieldBan className="h-3.5 w-3.5 text-destructive" />
                      ) : (
                        <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </Button>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(insight.createdAt)}
                  </TableCell>
                  <TableCell>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete insight?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will soft-delete "{truncate(insight.title, 50)}". It can be recovered later.
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      ) : (
        <div className="text-center py-12">
          <Lightbulb className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-medium">No insights yet</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Insights are discovered by the report agent during analysis, or created manually by users.
          </p>
        </div>
      )}
    </div>
  );
}
