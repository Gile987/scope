// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import type { CodingAgent } from "@/types";
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
import { Trash2, Eye, Bot } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";

export function AgentList() {
  const queryClient = useQueryClient();

  const { data: agents = [], isLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.listAgents(),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteAgent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success("Agent deleted");
    },
  });

  const activeAgents = agents.filter((a: CodingAgent) => !a.deletedAt);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground">Coding agents and their supported models</p>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : activeAgents.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No agents registered yet. Agents are seeded automatically on deployment.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Availability</TableHead>
                <TableHead>Model Provider</TableHead>
                <TableHead>Supported Models</TableHead>
                <TableHead>Default Model</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeAgents.map((agent: CodingAgent) => (
                <TableRow key={agent._id}>
                  <TableCell className="font-mono text-xs">
                    <Link to={`/agents/${agent._id}`} className="hover:underline flex items-center gap-1.5">
                      <Bot className="h-3.5 w-3.5" />
                      {agent._id}
                    </Link>
                  </TableCell>
                  <TableCell>{agent.name}</TableCell>
                  <TableCell>
                    {agent.available === false ? (
                      <Badge variant="secondary" className="text-xs">Unavailable</Badge>
                    ) : (
                      <Badge variant="default" className="text-xs">Available</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {agent.modelProvider ? (
                      <Badge variant="outline" className="text-xs font-mono">{agent.modelProvider}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {agent.supportedModels.length > 0
                        ? agent.supportedModels.map((m) => (
                            <Badge key={m} variant={m === agent.defaultModel ? "default" : "secondary"} className="text-xs">
                              {m}
                            </Badge>
                          ))
                        : <span className="text-xs text-muted-foreground">—</span>
                      }
                    </div>
                  </TableCell>
                  <TableCell>
                    {agent.defaultModel ? (
                      <Badge variant="outline">{agent.defaultModel}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(agent.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Link to={`/agents/${agent._id}`}>
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
                            <AlertDialogTitle>Delete agent?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This soft-deletes the agent definition. It can be re-seeded on next deployment.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteMutation.mutate(agent._id)}>
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
