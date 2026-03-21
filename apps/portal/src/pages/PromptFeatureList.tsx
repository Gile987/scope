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
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Trash2, Eye, Search, RefreshCw } from "lucide-react";
import { truncate } from "@/lib/utils";

export function PromptFeatureList() {
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();

  const { data: features = [], isLoading, isRefetching } = useQuery({
    queryKey: ["prompt-features", search],
    queryFn: () => api.listPromptFeatures(search || undefined),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deletePromptFeature,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["prompt-features"] }),
  });

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Prompt Features</h1>
          <p className="text-muted-foreground">Manage prompt feature detection</p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/prompt-features/new">
            <Button className="gap-1.5">
              <Plus className="h-4 w-4" /> New Feature
            </Button>
          </Link>
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 max-w-sm">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search prompt features…"
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
      ) : features.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {search ? "No prompt features match your search" : "No prompt features defined yet"}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[200px]">ID</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead className="w-[100px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {features.map((f) => (
                <TableRow key={f.id}>
                  <TableCell>
                    <Link
                      to={`/prompt-features/${f.id}`}
                      className="font-mono text-sm font-medium hover:underline"
                    >
                      {f.id}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {truncate(f.prompt, 100)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      <Link to={`/prompt-features/${f.id}`}>
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
                            <AlertDialogTitle>Delete prompt feature?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will delete <strong>{f.id}</strong>. This action cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteMutation.mutate(f.id)}
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
          {features.length} {features.length === 1 ? "feature" : "features"} total
        </p>
      )}
    </div>
  );
}
