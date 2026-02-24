// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
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
import { Plus, Trash2, Eye, RefreshCw } from "lucide-react";
import { truncate } from "@/lib/utils";

function triggerLabel(trigger?: { type: string }): string {
  if (!trigger) return "always";
  return trigger.type;
}

function triggerVariant(type: string): "default" | "secondary" | "outline" | "destructive" {
  switch (type) {
    case "always": return "default";
    case "criteria": return "secondary";
    case "taskPrompt": return "outline";
    case "promptFeature": return "outline";
    default: return "default";
  }
}

export function ReportTemplateList() {
  const queryClient = useQueryClient();

  const { data: templates = [], isLoading, isRefetching } = useQuery({
    queryKey: ["report-templates"],
    queryFn: () => api.listReportTemplates(),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteReportTemplate,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["report-templates"] }),
  });

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Report Templates</h1>
          <p className="text-muted-foreground">Manage report generation templates and their triggers</p>
        </div>
        <div className="flex items-center gap-2">
          {isRefetching && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
          <Link to="/report-templates/new">
            <Button className="gap-1.5">
              <Plus className="h-4 w-4" /> New Template
            </Button>
          </Link>
        </div>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No report templates defined yet. Reports will use the default prompt.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[180px]">ID</TableHead>
                <TableHead className="w-[200px]">Name</TableHead>
                <TableHead className="w-[120px]">Trigger</TableHead>
                <TableHead className="w-[100px]">Sys Prompt</TableHead>
                <TableHead>User Prompt</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((t) => {
                const tType = triggerLabel(t.trigger);
                return (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Link
                        to={`/report-templates/${t.id}`}
                        className="font-mono text-sm font-medium hover:underline"
                      >
                        {t.id}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{t.name}</TableCell>
                    <TableCell>
                      <Badge variant={triggerVariant(tType)} className="text-xs font-mono">
                        {tType}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {t.systemPrompt ? t.systemPrompt.mode : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {truncate(t.userPrompt, 80)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 justify-end">
                        <Link to={`/report-templates/${t.id}`}>
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
                              <AlertDialogTitle>Delete template?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will delete <strong>{t.id}</strong>. Existing reports generated from this template will not be affected.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => deleteMutation.mutate(t.id)}
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
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {!isLoading && (
        <p className="text-sm text-muted-foreground">
          {templates.length} {templates.length === 1 ? "template" : "templates"} total
        </p>
      )}
    </div>
  );
}
