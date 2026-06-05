// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Server } from "lucide-react";
import { api } from "@/lib/api";
import { DetailPanel } from "@/components/list-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";

export function McpServerPreviewPanel() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const { data: server, isLoading, error } = useQuery({
    queryKey: ["mcp-server", slug],
    queryFn: () => api.getMcpServer(slug!),
    enabled: !!slug,
  });

  const closePanel = () =>
    navigate({ pathname: "/mcp-servers", search: window.location.search });

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

  if (error || !server) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">MCP server not found.</p>
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title={
        <span className="flex items-center gap-1.5 truncate">
          <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{server.name}</span>
        </span>
      }
      subtitle={<span className="font-mono">{server.id}</span>}
      onClose={closePanel}
      headerActions={
        <div className="flex justify-end">
          <Link to={`/mcp-servers/${server.id}`}>
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
            <CardTitle className="text-sm">Transport</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-xs uppercase">{server.type}</Badge>
              {server.sessionMode && (
                <Badge variant="secondary" className="text-xs">{server.sessionMode}</Badge>
              )}
              {server.version && (
                <Badge variant="outline" className="font-mono text-xs">{server.version}</Badge>
              )}
            </div>
            <dl className="mt-3 space-y-2 text-sm">
              {server.type === "stdio" ? (
                <>
                  <div>
                    <dt className="text-xs text-muted-foreground">Command</dt>
                    <dd className="mt-0.5 break-all font-mono text-xs">{server.command}</dd>
                  </div>
                  {server.args && server.args.length > 0 && (
                    <div>
                      <dt className="text-xs text-muted-foreground">Arguments</dt>
                      <dd className="mt-0.5 break-all font-mono text-xs">
                        {server.args.join(" ")}
                      </dd>
                    </div>
                  )}
                </>
              ) : (
                <div>
                  <dt className="text-xs text-muted-foreground">URL</dt>
                  <dd className="mt-0.5 break-all font-mono text-xs">{server.url}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>

        {server.description && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {server.description}
              </p>
            </CardContent>
          </Card>
        )}

        {server.headers && server.headers.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Headers</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-1 text-xs">
                {server.headers.map((h) => (
                  <div key={h.name} className="flex items-baseline gap-2">
                    <dt className="font-mono text-muted-foreground">{h.name}:</dt>
                    <dd className="break-all font-mono">{h.value}</dd>
                  </div>
                ))}
              </dl>
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
                <dd className="mt-0.5 font-mono text-xs">{formatDate(server.createdAt)}</dd>
              </div>
              {server.updatedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(server.updatedAt)}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>
    </DetailPanel>
  );
}
