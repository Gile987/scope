// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import type { KeyDocument, KeyCapability } from "@/types";
import { KEY_TYPE_LABELS, KEY_CAPABILITY_LABELS, ALL_CAPABILITIES } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Eye, RefreshCw, ShieldCheck, KeyRound, AlertTriangle } from "lucide-react";
import { formatDate, formatId } from "@/lib/utils";
import { toast } from "sonner";
import { useState } from "react";

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "valid": return "default";
    case "invalid":
    case "expired": return "destructive";
    case "error": return "secondary";
    default: return "outline";
  }
}

export function TokenList() {
  const [capabilityFilter, setCapabilityFilter] = useState<string>("all");
  const queryClient = useQueryClient();

  const { data: tokens = [], isLoading, isRefetching } = useQuery({
    queryKey: ["tokens", capabilityFilter],
    queryFn: () => api.listKeys(capabilityFilter === "all" ? undefined : capabilityFilter),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      toast.success("Key deleted");
    },
  });

  const validateMutation = useMutation({
    mutationFn: api.validateKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      toast.success("Key validated");
    },
  });

  const activeTokens = tokens.filter((t: KeyDocument) => !t.deletedAt);

  // Find capabilities that have no valid, enabled tokens
  const coveredCapabilities = new Set<KeyCapability>();
  for (const t of activeTokens) {
    if (t.enabled && t.lastValidationStatus === "valid") {
      for (const c of t.capabilities ?? []) {
        coveredCapabilities.add(c);
      }
    }
  }
  const uncoveredCapabilities = ALL_CAPABILITIES.filter((c) => !coveredCapabilities.has(c));

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Keys</h1>
          <p className="text-muted-foreground">Manage API keys for workers and services</p>
        </div>
        <Link to="/secrets/keys/new">
          <Button className="gap-1.5">
            <Plus className="h-4 w-4" /> Register Key
          </Button>
        </Link>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2 max-w-xs">
        <Select value={capabilityFilter} onValueChange={setCapabilityFilter}>
          <SelectTrigger className="h-9">
            <SelectValue placeholder="Filter by capability" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All capabilities</SelectItem>
            {ALL_CAPABILITIES.map((c) => (
              <SelectItem key={c} value={c}>{KEY_CAPABILITY_LABELS[c]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isRefetching && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Uncovered capabilities warning */}
      {!isLoading && uncoveredCapabilities.length > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            <span className="font-medium">Missing coverage:</span>{" "}
            {uncoveredCapabilities.map((c) => KEY_CAPABILITY_LABELS[c]).join(", ")}.
            Register a key with these capabilities to enable the corresponding features.
          </span>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : activeTokens.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No keys registered yet
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Comment</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Last Validated</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Acquired</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeTokens.map((token: KeyDocument) => (
                <TableRow key={token._id}>
                  <TableCell className="font-mono text-xs">
                    <Link to={`/secrets/keys/${token._id}`} className="hover:underline">
                      {formatId(token._id)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm max-w-[200px] truncate" title={token.comment ?? undefined}>
                    {token.comment || <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="gap-1">
                      <KeyRound className="h-3 w-3" />
                      {KEY_TYPE_LABELS[token.type]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(token.capabilities ?? []).length > 0
                        ? token.capabilities.map((c) => (
                            <Badge key={c} variant="secondary" className="text-xs">
                              {KEY_CAPABILITY_LABELS[c]}
                            </Badge>
                          ))
                        : <span className="text-xs text-muted-foreground">—</span>
                      }
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(token.lastValidationStatus)}>
                      {token.lastValidationStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={token.enabled ? "default" : "secondary"}>
                      {token.enabled ? "Yes" : "No"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {token.lastValidatedAt ? formatDate(token.lastValidatedAt) : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(token.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {(token.acquireCount ?? 0).toLocaleString()}×
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Link to={`/secrets/keys/${token._id}`}>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Eye className="h-4 w-4" />
                        </Button>
                      </Link>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        disabled={validateMutation.isPending}
                        onClick={() => validateMutation.mutate(token._id)}
                      >
                        <ShieldCheck className="h-4 w-4" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete key?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This soft-deletes the key. The KeyVault secret is preserved.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteMutation.mutate(token._id)}>
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
    </div>
  );
}
