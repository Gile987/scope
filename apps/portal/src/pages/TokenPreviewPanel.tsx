// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, KeyRound } from "lucide-react";
import { api } from "@/lib/api";
import type { KeyValidationStatus } from "@/types";
import { KEY_TYPE_LABELS, KEY_CAPABILITY_LABELS } from "@/types";
import { DetailPanel } from "@/components/list-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatId } from "@/lib/utils";

function statusVariant(status: KeyValidationStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "valid": return "default";
    case "invalid":
    case "expired": return "destructive";
    case "error": return "secondary";
    default: return "outline";
  }
}

export function TokenPreviewPanel() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: token, isLoading, error } = useQuery({
    queryKey: ["token", id],
    queryFn: () => api.getKey(id!),
    enabled: !!id,
  });

  const closePanel = () =>
    navigate({ pathname: "/secrets/keys", search: window.location.search });

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

  if (error || !token) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Key not found.</p>
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title={
        <span className="flex items-center gap-1.5 truncate">
          <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{token.comment || formatId(token._id)}</span>
        </span>
      }
      subtitle={<span className="font-mono">{token._id}</span>}
      onClose={closePanel}
      headerActions={
        <div className="flex justify-end">
          <Link to={`/secrets/keys/${token._id}`}>
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
            <CardTitle className="text-sm">Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant(token.lastValidationStatus)} className="text-xs">
                {token.lastValidationStatus}
              </Badge>
              <Badge variant={token.enabled ? "default" : "secondary"} className="text-xs">
                {token.enabled ? "Enabled" : "Disabled"}
              </Badge>
              <Badge variant="outline" className="text-xs">
                {KEY_TYPE_LABELS[token.type]}
              </Badge>
            </div>
            {token.lastValidationError && (
              <p className="mt-2 break-words font-mono text-xs text-destructive">
                {token.lastValidationError}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Capabilities</CardTitle>
          </CardHeader>
          <CardContent>
            {(token.capabilities ?? []).length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {token.capabilities.map((c) => (
                  <Badge key={c} variant="secondary" className="text-xs">
                    {KEY_CAPABILITY_LABELS[c]}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No capabilities recorded.</p>
            )}
          </CardContent>
        </Card>

        {token.comment && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Comment</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {token.comment}
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Usage</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Acquired</dt>
                <dd className="mt-0.5 font-mono text-xs">
                  {(token.acquireCount ?? 0).toLocaleString()}×
                </dd>
              </div>
              {token.lastAcquiredAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Last acquired</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(token.lastAcquiredAt)}</dd>
                </div>
              )}
              {token.lastValidatedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Last validated</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(token.lastValidatedAt)}</dd>
                </div>
              )}
              {token.expiresAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Expires</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(token.expiresAt)}</dd>
                </div>
              )}
            </dl>
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
                <dd className="mt-0.5 font-mono text-xs">{formatDate(token.createdAt)}</dd>
              </div>
              {token.updatedAt && (
                <div>
                  <dt className="text-xs text-muted-foreground">Updated</dt>
                  <dd className="mt-0.5 font-mono text-xs">{formatDate(token.updatedAt)}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      </div>
    </DetailPanel>
  );
}
