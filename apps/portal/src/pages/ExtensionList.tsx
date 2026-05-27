// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ExtensionDocument } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Trash2, Puzzle, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { ExtensionPicker } from "@/components/ExtensionPicker";

export function ExtensionList() {
  const queryClient = useQueryClient();

  const { data: extensions = [], isLoading } = useQuery({
    queryKey: ["extensions"],
    queryFn: () => api.listExtensions(),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteExtension,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["extensions"] });
      toast.success("Extension deleted");
    },
  });

  const activeExtensions = extensions.filter((e: ExtensionDocument) => !e.deletedAt);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Extensions</h1>
        <p className="text-muted-foreground">Manage VS Code extensions installed in worker environments</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Import Extension
          </CardTitle>
          <CardDescription>
            Search the VS Code marketplace to find and import extensions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ExtensionPicker selected={[]} onChange={() => {}} importOnly />
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : activeExtensions.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No extensions imported yet. Search the VS Code marketplace above to add one.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Publisher</TableHead>
                <TableHead>Origin</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeExtensions.map((ext: ExtensionDocument) => (
                <TableRow key={ext.id}>
                  <TableCell className="font-mono text-xs">
                    <Link to={`/extensions/${ext.id}`} className="flex items-center gap-1.5 hover:underline">
                      <Puzzle className="h-3.5 w-3.5" />
                      {ext.id}
                    </Link>
                  </TableCell>
                  <TableCell>{ext.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {ext.publisher}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {ext.origin}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(ext.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete extension?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This soft-deletes &quot;{ext.name}&quot;. It will no longer be available for new runs.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deleteMutation.mutate(ext.id)}>
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
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
