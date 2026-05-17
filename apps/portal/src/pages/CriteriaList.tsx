// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Trash2, Eye, Search, GitBranch, RefreshCw, Download } from "lucide-react";
import { truncate } from "@/lib/utils";
import { criteriaToExportYaml, downloadAsFile } from "@/lib/criteria-export";

export function CriteriaList() {
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();

  const { data: criteria = [], isLoading, isRefetching } = useQuery({
    queryKey: ["criteria", search],
    queryFn: () => api.listCriteria(search || undefined),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteCriterion,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["criteria"] }),
  });

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Criteria</h1>
          <p className="text-muted-foreground">Manage evaluation criteria and their dependencies</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="gap-1.5"
            disabled={criteria.length === 0}
            onClick={() => {
              const yaml = criteriaToExportYaml(criteria);
              downloadAsFile(yaml, "criteria.yaml");
            }}
          >
            <Download className="h-4 w-4" /> Export YAML
          </Button>
          <Link to="/criteria/graph">
            <Button variant="outline" className="gap-1.5">
              <GitBranch className="h-4 w-4" /> Graph
            </Button>
          </Link>
          <Link to="/criteria/new">
            <Button className="gap-1.5">
              <Plus className="h-4 w-4" /> New Criterion
            </Button>
          </Link>
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 max-w-sm">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search criteria…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9"
        />
        {isRefetching && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : criteria.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {search ? "No criteria match your search" : "No criteria defined yet"}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[200px]">ID</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead className="w-[200px]">Dependencies</TableHead>
                <TableHead className="w-[100px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {criteria.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link
                      to={`/criteria/${c.id}`}
                      className="font-mono text-sm font-medium hover:underline"
                    >
                      {c.id}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {truncate(c.prompt, 100)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(c.dependsOn ?? []).map((dep) => (
                        <Badge key={dep} variant="secondary" className="text-xs font-mono">
                          {dep}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      <Link to={`/criteria/${c.id}`}>
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
                            <AlertDialogTitle>Delete criterion?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will delete <strong>{c.id}</strong>. Criteria with dependents cannot be deleted.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteMutation.mutate(c.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
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

      {!isLoading && (
        <p className="text-sm text-muted-foreground">
          {criteria.length} {criteria.length === 1 ? "criterion" : "criteria"} total
        </p>
      )}
    </div>
  );
}
