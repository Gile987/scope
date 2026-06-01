// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, GitBranch } from "lucide-react";
import { api } from "@/lib/api";
import { DetailPanel } from "@/components/list-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";

export function CriterionPreviewPanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: criterion, isLoading, error } = useQuery({
    queryKey: ["criterion", id],
    queryFn: () => api.getCriterion(id!),
    enabled: !!id,
  });

  const closePanel = () =>
    navigate({ pathname: "/criteria", search: window.location.search });

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

  if (error || !criterion) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Criterion not found.</p>
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title={<span className="truncate font-mono text-sm">{criterion.id}</span>}
      subtitle="Evaluation criterion"
      onClose={closePanel}
      headerActions={
        <div className="flex flex-wrap justify-end gap-2">
          <Link to="/criteria/graph">
            <Button variant="outline" size="sm" className="gap-1.5">
              <GitBranch className="h-3.5 w-3.5" /> Graph
            </Button>
          </Link>
          <Link to={`/criteria/${criterion.id}`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" /> Open full view
            </Button>
          </Link>
        </div>
      }
    >
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Prompt</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {criterion.prompt}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Dependencies</CardTitle>
          </CardHeader>
          <CardContent>
            {criterion.dependsOn && criterion.dependsOn.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {criterion.dependsOn.map((dep) => (
                  <Badge key={dep} variant="secondary" className="font-mono text-xs">
                    {dep}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No dependencies.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd className="mt-0.5 font-mono text-xs">{formatDate(criterion.createdAt)}</dd>
              </div>
              {criterion.updatedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(criterion.updatedAt)}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>
    </DetailPanel>
  );
}
