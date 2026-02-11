// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Save, Trash2, Loader2 } from "lucide-react";
import { formatDate } from "@/lib/utils";

export function CriterionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: criterion, isLoading, error } = useQuery({
    queryKey: ["criterion", id],
    queryFn: () => api.getCriterion(id!),
    enabled: !!id,
  });

  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [dependsOnText, setDependsOnText] = useState("");

  const updateMutation = useMutation({
    mutationFn: (body: { prompt?: string; dependsOn?: string[] }) =>
      api.updateCriterion(id!, body),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["criterion", id] });
      queryClient.invalidateQueries({ queryKey: ["criteria"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteCriterion,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["criteria"] });
      navigate("/criteria");
    },
  });

  const startEditing = () => {
    if (!criterion) return;
    setPrompt(criterion.prompt);
    setDependsOnText((criterion.dependsOn ?? []).join("\n"));
    setEditing(true);
  };

  const handleSave = () => {
    const deps = dependsOnText
      .split("\n")
      .map((d) => d.trim())
      .filter(Boolean);
    updateMutation.mutate({
      prompt: prompt.trim(),
      dependsOn: deps.length > 0 ? deps : undefined,
    });
  };

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !criterion) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <Link to="/criteria" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Criteria
        </Link>
        <div className="text-center py-12 text-muted-foreground">
          Criterion not found
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link to="/criteria" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to Criteria
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight font-mono">{criterion.id}</h1>
          <p className="text-sm text-muted-foreground">
            Created {formatDate(criterion.createdAt)}
            {criterion.updatedAt && ` · Updated ${formatDate(criterion.updatedAt)}`}
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
                <AlertDialogTitle>Delete criterion?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete <strong>{criterion.id}</strong>.
                  {criterion.dependents.length > 0 && (
                    <span className="block mt-2 text-destructive">
                      Cannot delete: used by {criterion.dependents.join(", ")}
                    </span>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate(criterion.id)}
                  disabled={criterion.dependents.length > 0}
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
          <CardTitle>Prompt</CardTitle>
          <CardDescription>The evaluation prompt sent to the judge LLM</CardDescription>
        </CardHeader>
        <CardContent>
          {editing ? (
            <div className="space-y-3">
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={6}
                className="font-mono text-sm"
              />
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm">{criterion.prompt}</p>
          )}
        </CardContent>
      </Card>

      {/* Dependencies */}
      <Card>
        <CardHeader>
          <CardTitle>Dependencies</CardTitle>
          <CardDescription>
            Criteria that must pass before this one is evaluated
          </CardDescription>
        </CardHeader>
        <CardContent>
          {editing ? (
            <div className="space-y-2">
              <Label htmlFor="deps">
                Dependency IDs <span className="text-muted-foreground font-normal">(one per line)</span>
              </Label>
              <Textarea
                id="deps"
                value={dependsOnText}
                onChange={(e) => setDependsOnText(e.target.value)}
                rows={4}
                placeholder="has_node&#10;has_typescript"
                className="font-mono text-sm"
              />
            </div>
          ) : (criterion.dependsOn ?? []).length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {criterion.dependsOn!.map((dep) => (
                <Link key={dep} to={`/criteria/${dep}`}>
                  <Badge variant="secondary" className="font-mono cursor-pointer hover:bg-secondary/80">
                    {dep}
                  </Badge>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No dependencies (root criterion)</p>
          )}
        </CardContent>
      </Card>

      {/* Dependents */}
      {criterion.dependents.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Dependents</CardTitle>
            <CardDescription>Criteria that depend on this one</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {criterion.dependents.map((dep) => (
                <Link key={dep} to={`/criteria/${dep}`}>
                  <Badge variant="outline" className="font-mono cursor-pointer hover:bg-accent">
                    {dep}
                  </Badge>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

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
