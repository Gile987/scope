// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Save, Trash2, Loader2, Sparkles, Check, X } from "lucide-react";
import { formatDate } from "@/lib/utils";

export function PromptFeatureDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: feature, isLoading, error } = useQuery({
    queryKey: ["prompt-feature", id],
    queryFn: () => api.getPromptFeature(id!),
    enabled: !!id,
  });

  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState("");

  // AI Suggest state
  const [aiSuggestOpen, setAiSuggestOpen] = useState(false);
  const [behaviorInput, setBehaviorInput] = useState("");
  const [suggestedPrompt, setSuggestedPrompt] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: (body: { prompt?: string }) =>
      api.updatePromptFeature(id!, body),
    onSuccess: () => {
      setEditing(false);
      setAiSuggestOpen(false);
      setSuggestedPrompt(null);
      queryClient.invalidateQueries({ queryKey: ["prompt-feature", id] });
      queryClient.invalidateQueries({ queryKey: ["prompt-features"] });
    },
  });

  const aiSuggestMutation = useMutation({
    mutationFn: (behavior: string) => api.generatePromptFeaturePrompt(behavior, id),
    onSuccess: (data) => {
      setSuggestedPrompt(data.prompt);
    },
    onError: () => {
      setSuggestedPrompt(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deletePromptFeature,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompt-features"] });
      navigate("/prompt-features");
    },
  });

  const startEditing = () => {
    if (!feature) return;
    setPrompt(feature.prompt);
    setAiSuggestOpen(false);
    setBehaviorInput("");
    setSuggestedPrompt(null);
    setEditing(true);
  };

  const handleSave = () => {
    updateMutation.mutate({
      prompt: prompt.trim(),
    });
  };

  const handleAiSuggest = () => {
    if (!behaviorInput.trim()) return;
    aiSuggestMutation.mutate(behaviorInput.trim());
  };

  const handleAcceptPrompt = () => {
    if (suggestedPrompt) setPrompt(suggestedPrompt);
    setSuggestedPrompt(null);
  };

  const handleDismissPrompt = () => {
    setSuggestedPrompt(null);
  };

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !feature) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <Link to="/prompt-features" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Prompt Features
        </Link>
        <div className="text-center py-12 text-muted-foreground">
          Prompt feature not found
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link to="/prompt-features" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to Prompt Features
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight font-mono">{feature.id}</h1>
          <p className="text-sm text-muted-foreground">
            Created {formatDate(feature.createdAt)}
            {feature.updatedAt && ` · Updated ${formatDate(feature.updatedAt)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!editing && (
            <Button variant="outline" onClick={startEditing}>
              Edit
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="icon" className="h-9 w-9">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete prompt feature?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete <strong>{feature.id}</strong>. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate(feature.id)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Prompt */}
      <Card>
        <CardHeader>
          <CardTitle>Detection Prompt</CardTitle>
          <CardDescription>The prompt used to detect this feature in task text</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {editing ? (
            <>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={6}
                className="font-mono text-sm"
              />

              {/* AI Suggest section */}
              {!aiSuggestOpen ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setAiSuggestOpen(true)}
                >
                  <Sparkles className="h-4 w-4" />
                  AI Suggest
                </Button>
              ) : (
                <div className="space-y-3 rounded-md border p-3 bg-muted/30">
                  <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
                    AI Suggest
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      value={behaviorInput}
                      onChange={(e) => setBehaviorInput(e.target.value)}
                      placeholder="Describe the feature to refine suggestions..."
                      className="text-sm"
                      onKeyDown={(e) => e.key === "Enter" && handleAiSuggest()}
                    />
                    <Button
                      size="sm"
                      onClick={handleAiSuggest}
                      disabled={aiSuggestMutation.isPending || !behaviorInput.trim()}
                      className="gap-1.5"
                    >
                      {aiSuggestMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Sparkles className="h-4 w-4" />
                      )}
                      Generate
                    </Button>
                  </div>

                  {aiSuggestMutation.isError && (
                    <p className="text-sm text-destructive">
                      {aiSuggestMutation.error instanceof Error
                        ? aiSuggestMutation.error.message
                        : "AI suggestion failed"}
                    </p>
                  )}

                  {/* Suggested prompt */}
                  {suggestedPrompt && (
                    <div className="space-y-2 border rounded-md p-3 bg-background">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
                          Suggested Prompt
                        </Label>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={handleAcceptPrompt}
                          >
                            <Check className="h-3 w-3" /> Accept
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={handleDismissPrompt}
                          >
                            <X className="h-3 w-3" /> Dismiss
                          </Button>
                        </div>
                      </div>
                      <p className="whitespace-pre-wrap text-sm font-mono bg-muted/50 rounded p-2">
                        {suggestedPrompt}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="whitespace-pre-wrap text-sm">{feature.prompt}</p>
          )}
        </CardContent>
      </Card>

      {/* Edit actions */}
      {editing && (
        <>
          <Separator />
          <div className="flex items-center justify-between">
            {updateMutation.isError && (
              <p className="text-sm text-destructive">
                {updateMutation.error instanceof Error ? updateMutation.error.message : "Update failed"}
              </p>
            )}
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={updateMutation.isPending} className="gap-1.5">
                {updateMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
