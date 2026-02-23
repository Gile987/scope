// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import type { Model } from "@/types";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Eye, Cpu } from "lucide-react";
import { formatDate } from "@/lib/utils";

export function ModelList() {
  const { data: models = [], isLoading } = useQuery({
    queryKey: ["models"],
    queryFn: () => api.listModels(),
  });

  // Group by provider for summary
  const providerCounts = models.reduce<Record<string, number>>((acc, m) => {
    acc[m.provider] = (acc[m.provider] ?? 0) + 1;
    return acc;
  }, {});

  const activeModels = models.filter((m: Model) => !m.disappearedAt);
  const disappearedModels = models.filter((m: Model) => m.disappearedAt);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Models</h1>
          <p className="text-muted-foreground">
            Scanned models across all providers
            {Object.keys(providerCounts).length > 0 && (
              <span className="ml-2">
                ({Object.entries(providerCounts)
                  .map(([p, c]) => `${c} ${p}`)
                  .join(", ")})
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Active models table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : activeModels.length === 0 && disappearedModels.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No models found. Models are discovered automatically by model scanners.
        </div>
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model ID</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>First Seen</TableHead>
                  <TableHead>Last Seen</TableHead>
                  <TableHead>Available From</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeModels.map((model: Model) => (
                  <TableRow key={model._id}>
                    <TableCell className="font-mono text-xs">
                      <Link to={`/models/${encodeURIComponent(model._id)}`} className="hover:underline flex items-center gap-1.5">
                        <Cpu className="h-3.5 w-3.5" />
                        {model.modelId}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{model.provider}</Badge>
                    </TableCell>
                    <TableCell>
                      <Link to={`/agents/${model.agentId}`} className="hover:underline text-xs">
                        {model.agentId}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(model.firstSeenAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(model.lastSeenAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {model.providerAvailableFrom
                        ? formatDate(model.providerAvailableFrom)
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link to={`/models/${encodeURIComponent(model._id)}`}>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Eye className="h-4 w-4" />
                        </Button>
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Disappeared models */}
          {disappearedModels.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold text-muted-foreground">
                Disappeared ({disappearedModels.length})
              </h2>
              <div className="rounded-md border opacity-60">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model ID</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead>First Seen</TableHead>
                      <TableHead>Disappeared</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {disappearedModels.map((model: Model) => (
                      <TableRow key={model._id}>
                        <TableCell className="font-mono text-xs">
                          <Link to={`/models/${encodeURIComponent(model._id)}`} className="hover:underline flex items-center gap-1.5">
                            <Cpu className="h-3.5 w-3.5" />
                            {model.modelId}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{model.provider}</Badge>
                        </TableCell>
                        <TableCell>
                          <Link to={`/agents/${model.agentId}`} className="hover:underline text-xs">
                            {model.agentId}
                          </Link>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(model.firstSeenAt)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {model.disappearedAt
                            ? formatDate(model.disappearedAt)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Link to={`/models/${encodeURIComponent(model._id)}`}>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <Eye className="h-4 w-4" />
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
