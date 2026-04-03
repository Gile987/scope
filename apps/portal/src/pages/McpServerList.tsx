// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import type { McpServerDocument } from "@/types";
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
import { Plus, Trash2, Eye, Server } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";

export function McpServerList() {
  const queryClient = useQueryClient();

  const { data: servers = [], isLoading } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.listMcpServers(),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteMcpServer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      toast.success("MCP server deleted");
    },
  });

  const activeServers = servers.filter((s: McpServerDocument) => !s.deletedAt);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">MCP Servers</h1>
          <p className="text-muted-foreground">Manage remote MCP servers available for benchmark runs</p>
        </div>
        <Link to="/mcp-servers/new">
          <Button className="gap-1.5">
            <Plus className="h-4 w-4" /> Add Server
          </Button>
        </Link>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : activeServers.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No MCP servers registered yet. Add one to make it available during run submission.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>URL / Command</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeServers.map((server: McpServerDocument) => (
                <TableRow key={server._id}>
                  <TableCell className="font-mono text-xs">
                    <Link to={`/mcp-servers/${server._id}`} className="hover:underline flex items-center gap-1.5">
                      <Server className="h-3.5 w-3.5" />
                      {server._id}
                    </Link>
                  </TableCell>
                  <TableCell>{server.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs uppercase">
                      {server.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[300px] truncate text-xs text-muted-foreground font-mono">
                    {server.type === "stdio" ? server.command : server.url}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground font-mono">
                    {server.version ?? <span className="text-muted-foreground/40">&mdash;</span>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(server.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Link to={`/mcp-servers/${server._id}`}>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <Eye className="h-4 w-4" />
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
                            <AlertDialogTitle>Delete MCP server?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This soft-deletes the MCP server &quot;{server.name}&quot;. It will no longer be available for new runs.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteMutation.mutate(server._id)}>
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
