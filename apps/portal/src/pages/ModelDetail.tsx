// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Cpu } from "lucide-react";
import { formatDate } from "@/lib/utils";

export function ModelDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: model, isLoading, error } = useQuery({
    queryKey: ["model", id],
    queryFn: () => api.getModel(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !model) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/models")}>
          <ArrowLeft className="h-4 w-4" /> Back to Models
        </Button>
        <div className="text-center py-12 text-muted-foreground">
          Model not found
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Back link */}
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/models")}>
        <ArrowLeft className="h-4 w-4" /> Back to Models
      </Button>

      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <Cpu className="h-5 w-5" />
          <h1 className="text-2xl font-bold tracking-tight">{model.modelId}</h1>
        </div>
        <p className="text-sm text-muted-foreground font-mono mt-1">{model._id}</p>
      </div>

      {/* Overview card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Provider</span>
              <div className="mt-1">
                <Badge variant="outline">{model.provider}</Badge>
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Agent</span>
              <div className="mt-1">
                <Link to={`/agents/${model.agentId}`} className="hover:underline font-mono text-xs">
                  {model.agentId}
                </Link>
              </div>
            </div>
            <div>
              <span className="text-muted-foreground">Status</span>
              <div className="mt-1">
                {model.disappearedAt ? (
                  <Badge variant="secondary">Disappeared</Badge>
                ) : (
                  <Badge variant="default">Active</Badge>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Lifecycle card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lifecycle</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">First Seen</span>
              <div className="mt-1 font-mono text-xs">{formatDate(model.firstSeenAt)}</div>
            </div>
            <div>
              <span className="text-muted-foreground">Last Seen</span>
              <div className="mt-1 font-mono text-xs">{formatDate(model.lastSeenAt)}</div>
            </div>
            {model.disappearedAt && (
              <div>
                <span className="text-muted-foreground">Disappeared At</span>
                <div className="mt-1 font-mono text-xs">{formatDate(model.disappearedAt)}</div>
              </div>
            )}
            {model.providerAvailableFrom && (
              <div>
                <span className="text-muted-foreground">Provider Available From</span>
                <div className="mt-1 font-mono text-xs">{formatDate(model.providerAvailableFrom)}</div>
              </div>
            )}
            {model.providerEndOfLife && (
              <div>
                <span className="text-muted-foreground">Provider End of Life</span>
                <div className="mt-1 font-mono text-xs text-destructive">{formatDate(model.providerEndOfLife)}</div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Metadata card */}
      {model.metadata && Object.keys(model.metadata).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Metadata</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              {Object.entries(model.metadata).map(([key, value]) => (
                <div key={key}>
                  <span className="text-muted-foreground">{key}</span>
                  <div className="mt-1 font-mono text-xs">
                    {typeof value === "string" || typeof value === "number"
                      ? String(value)
                      : JSON.stringify(value)}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
