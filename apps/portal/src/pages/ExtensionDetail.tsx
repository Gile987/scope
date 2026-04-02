// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Trash2, Puzzle } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";

export function ExtensionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const { data: extension, isLoading, error } = useQuery({
    queryKey: ["extension", id],
    queryFn: () => api.getExtension(id!),
    enabled: !!id,
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteExtension(id!),
    onSuccess: () => {
      toast.success("Extension deleted");
      navigate("/extensions");
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !extension) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/extensions")}>
          <ArrowLeft className="h-4 w-4" /> Back to Extensions
        </Button>
        <div className="text-center py-12 text-muted-foreground">
          Extension not found
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/extensions")}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Puzzle className="h-6 w-6" />
            {extension.name}
          </h1>
          <Badge variant="outline">{extension.origin}</Badge>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm" className="gap-1.5">
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete extension?</AlertDialogTitle>
              <AlertDialogDescription>
                This soft-deletes &quot;{extension.name}&quot;. It will no longer be available for new runs.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteMutation.mutate()}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Extension Details</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-[10rem_1fr] gap-y-3 text-sm">
            <span className="text-muted-foreground">ID</span>
            <span className="font-mono">{extension._id}</span>

            <span className="text-muted-foreground">Publisher</span>
            <span className="font-mono">{extension.publisher}</span>

            <span className="text-muted-foreground">Display Name</span>
            <span>{extension.name}</span>

            <span className="text-muted-foreground">Origin</span>
            <Badge variant="outline">{extension.origin}</Badge>

            {extension.description && (
              <>
                <span className="text-muted-foreground">Description</span>
                <span>{extension.description}</span>
              </>
            )}

            <span className="text-muted-foreground">Created</span>
            <span>{formatDate(extension.createdAt)}</span>

            {extension.updatedAt && (
              <>
                <span className="text-muted-foreground">Updated</span>
                <span>{formatDate(extension.updatedAt)}</span>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
