// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  ThumbsUp,
  ThumbsDown,
  ShieldBan,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/api";
import { DetailPanel } from "@/components/list-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, truncate } from "@/lib/utils";

export function InsightPreviewPanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: insight, isLoading, error } = useQuery({
    queryKey: ["insight", id],
    queryFn: () => api.getInsight(id!),
    enabled: !!id,
  });

  const closePanel = () =>
    navigate({ pathname: "/insights", search: window.location.search });

  const upvoteMutation = useMutation({
    mutationFn: () => api.upvoteInsight(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["insight", id] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
  });

  const downvoteMutation = useMutation({
    mutationFn: () => api.downvoteInsight(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["insight", id] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
  });

  const blockMutation = useMutation({
    mutationFn: (blocked: boolean) =>
      blocked ? api.blockInsight(id!) : api.unblockInsight(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["insight", id] });
      queryClient.invalidateQueries({ queryKey: ["insights"] });
    },
  });

  if (isLoading) {
    return (
      <DetailPanel title="Loading…" onClose={closePanel}>
        <div className="space-y-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-32 w-full" />
        </div>
      </DetailPanel>
    );
  }

  if (error || !insight) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Insight not found.</p>
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title={<span className="truncate">{truncate(insight.title, 60)}</span>}
      subtitle={insight.category ?? "Insight"}
      onClose={closePanel}
      headerActions={
        <div className="flex justify-end">
          <Link to={`/insights/${insight.id}`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" />
              Open full view
            </Button>
          </Link>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Status */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                {insight.createdBy === "agent" ? "Agent" : "User"}
              </Badge>
              {insight.blocked && (
                <Badge variant="destructive" className="text-xs">Blocked</Badge>
              )}
              {insight.category && (
                <Badge variant="outline" className="text-xs">{insight.category}</Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Description preview */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Description</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {truncate(insight.description, 400)}
            </p>
          </CardContent>
        </Card>

        {/* Tags */}
        {insight.tags && insight.tags.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Tags</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5">
                {insight.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stats */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Engagement</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={upvoteMutation.isPending}
                  onClick={() => upvoteMutation.mutate()}
                  title="Upvote"
                >
                  <ThumbsUp className="h-3.5 w-3.5" />
                </Button>
                <span className="text-sm tabular-nums">
                  {insight.upvotes - insight.downvotes}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={downvoteMutation.isPending}
                  onClick={() => downvoteMutation.mutate()}
                  title="Downvote"
                >
                  <ThumbsDown className="h-3.5 w-3.5" />
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                disabled={blockMutation.isPending}
                onClick={() => blockMutation.mutate(!insight.blocked)}
              >
                {insight.blocked ? (
                  <>
                    <ShieldCheck className="h-3.5 w-3.5" /> Unblock
                  </>
                ) : (
                  <>
                    <ShieldBan className="h-3.5 w-3.5" /> Block
                  </>
                )}
              </Button>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">References</dt>
                <dd className="mt-0.5 font-mono text-xs">{insight.referenceCount}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Upvotes</dt>
                <dd className="mt-0.5 font-mono text-xs">{insight.upvotes}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Downvotes</dt>
                <dd className="mt-0.5 font-mono text-xs">{insight.downvotes}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Timeline */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd className="mt-0.5 font-mono text-xs">{formatDate(insight.createdAt)}</dd>
              </div>
              {insight.updatedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(insight.updatedAt)}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>
    </DetailPanel>
  );
}
