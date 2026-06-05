// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Puzzle } from "lucide-react";
import { api } from "@/lib/api";
import { DetailPanel } from "@/components/list-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";

export function ExtensionPreviewPanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: extension, isLoading, error } = useQuery({
    queryKey: ["extension", id],
    queryFn: () => api.getExtension(id!),
    enabled: !!id,
  });

  const closePanel = () =>
    navigate({ pathname: "/extensions", search: window.location.search });

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

  if (error || !extension) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Extension not found.</p>
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title={
        <span className="flex items-center gap-1.5 truncate">
          <Puzzle className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{extension.name}</span>
        </span>
      }
      subtitle={extension.publisher}
      onClose={closePanel}
      headerActions={
        <div className="flex justify-end">
          <Link to={`/extensions/${extension._id}`}>
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
            <CardTitle className="text-sm">Identity</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">ID</dt>
                <dd className="mt-0.5 break-all font-mono text-xs">{extension._id}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Publisher</dt>
                <dd className="mt-0.5 font-mono text-xs">{extension.publisher}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Origin</dt>
                <dd className="mt-0.5">
                  <Badge variant="outline" className="text-xs">{extension.origin}</Badge>
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {extension.description && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {extension.description}
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd className="mt-0.5 font-mono text-xs">{formatDate(extension.createdAt)}</dd>
              </div>
              {extension.updatedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(extension.updatedAt)}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>
    </DetailPanel>
  );
}
