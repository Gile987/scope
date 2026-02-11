// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Plus, Loader2 } from "lucide-react";

export function CreateCriterion() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [id, setId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [dependsOnText, setDependsOnText] = useState("");

  const createMutation = useMutation({
    mutationFn: api.createCriterion,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["criteria"] });
      navigate(`/criteria/${data.id}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !prompt.trim()) return;

    const dependsOn = dependsOnText
      .split("\n")
      .map((d) => d.trim())
      .filter(Boolean);

    createMutation.mutate({
      id: id.trim(),
      prompt: prompt.trim(),
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New Criterion</h1>
        <p className="text-muted-foreground">Define a new evaluation criterion for the judge</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Definition</CardTitle>
            <CardDescription>The criterion ID must be a unique snake_case identifier</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="id">Criterion ID *</Label>
              <Input
                id="id"
                placeholder="e.g., has_unit_tests"
                value={id}
                onChange={(e) => setId(e.target.value)}
                pattern="[a-z][a-z0-9_]*"
                className="font-mono"
                required
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and underscores. Must start with a letter.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="prompt">Evaluation Prompt *</Label>
              <Textarea
                id="prompt"
                placeholder="Describe what the judge should check for…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={6}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="deps">
                Dependencies{" "}
                <span className="text-muted-foreground font-normal">(optional, one ID per line)</span>
              </Label>
              <Textarea
                id="deps"
                placeholder="has_node&#10;has_typescript"
                value={dependsOnText}
                onChange={(e) => setDependsOnText(e.target.value)}
                rows={3}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Criteria that must pass before this one is evaluated. Creates a dependency edge in the graph.
              </p>
            </div>
          </CardContent>
        </Card>

        <Separator />

        <div className="flex items-center justify-between">
          {createMutation.isError && (
            <p className="text-sm text-destructive">
              {createMutation.error instanceof Error ? createMutation.error.message : "Creation failed"}
            </p>
          )}
          <div className="flex-1" />
          <Button
            type="submit"
            disabled={!id.trim() || !prompt.trim() || createMutation.isPending}
            className="gap-1.5"
          >
            {createMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Create Criterion
          </Button>
        </div>
      </form>
    </div>
  );
}
