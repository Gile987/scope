// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Trash2, Loader2, Sparkles, Check, X, List } from "lucide-react";
import { formatDate } from "@/lib/utils";

export function TaskPromptDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: taskPrompt, isLoading, error } = useQuery({
    queryKey: ["task-prompt", id],
    queryFn: () => api.getTaskPrompt(id!),
    enabled: !!id,
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteTaskPrompt(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-prompts"] });
      navigate("/task-prompts");
    },
  });

  const extractMutation = useMutation({
    mutationFn: (force: boolean) => api.extractTaskPromptFeatures(id!, { force }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-prompt", id] });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error || !taskPrompt) {
    return (
      <div className="space-y-4">
        <Link to="/task-prompts" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to task prompts
        </Link>
        <div className="text-center py-12 text-destructive">
          {error instanceof Error ? error.message : "Task prompt not found"}
        </div>
      </div>
    );
  }

  const detected = taskPrompt.features?.filter((f) => f.detected) ?? [];
  const notDetected = taskPrompt.features?.filter((f) => !f.detected && f.evaluated) ?? [];
  const skipped = taskPrompt.features?.filter((f) => !f.evaluated) ?? [];

  return (
    <div className="space-y-6">
      {/* Back + header */}
      <div className="flex items-center justify-between">
        <Link to="/task-prompts" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to task prompts
        </Link>
        <div className="flex items-center gap-2">
          <Link to={`/runs?taskPromptId=${encodeURIComponent(taskPrompt._id)}`}>
            <Button variant="outline" className="gap-1.5">
              <List className="h-4 w-4" /> View Runs
            </Button>
          </Link>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="gap-1.5">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete task prompt?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will soft-delete this task prompt. Existing runs referencing it will not be affected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate()}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Identity card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Task Prompt</CardTitle>
          <CardDescription className="font-mono text-xs select-all">
            {taskPrompt._id}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Created</span>
            <p className="text-sm">{formatDate(taskPrompt.createdAt)}</p>
          </div>
          {taskPrompt.deletedAt && (
            <div className="space-y-1">
              <span className="text-sm font-medium text-destructive">Deleted</span>
              <p className="text-sm">{formatDate(taskPrompt.deletedAt)}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Task text card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Task Text</CardTitle>
          <CardDescription>Immutable — content determines the ID</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap text-sm bg-muted p-4 rounded-md font-mono leading-relaxed max-h-[400px] overflow-y-auto">
            {taskPrompt.text}
          </pre>
        </CardContent>
      </Card>

      {/* Features card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Prompt Features</CardTitle>
              <CardDescription>
                {taskPrompt.featuresExtractedAt
                  ? `Last extracted ${formatDate(taskPrompt.featuresExtractedAt)}`
                  : "Features have not been extracted yet"}
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => extractMutation.mutate(!!taskPrompt.features)}
              disabled={extractMutation.isPending}
            >
              {extractMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {taskPrompt.features ? "Re-extract" : "Extract Features"}
            </Button>
          </div>
        </CardHeader>
        {taskPrompt.features && taskPrompt.features.length > 0 && (
          <CardContent className="space-y-4">
            {detected.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-1.5">
                  <Check className="h-4 w-4 text-green-600" /> Detected ({detected.length})
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {detected.map((f) => (
                    <Link key={f.featureId} to={`/prompt-features/${f.featureId}`}>
                      <Badge variant="default" className="cursor-pointer hover:bg-primary/80">
                        {f.featureId}
                      </Badge>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {detected.length > 0 && (notDetected.length > 0 || skipped.length > 0) && (
              <Separator />
            )}

            {notDetected.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-1.5">
                  <X className="h-4 w-4 text-muted-foreground" /> Not Detected ({notDetected.length})
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {notDetected.map((f) => (
                    <Link key={f.featureId} to={`/prompt-features/${f.featureId}`}>
                      <Badge variant="outline" className="text-muted-foreground cursor-pointer hover:bg-accent">
                        {f.featureId}
                      </Badge>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {skipped.length > 0 && (
              <>
                {notDetected.length > 0 && <Separator />}
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-muted-foreground">
                    Skipped ({skipped.length})
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {skipped.map((f) => (
                      <Badge key={f.featureId} variant="secondary" className="text-muted-foreground">
                        {f.featureId}
                      </Badge>
                    ))}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
