// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CodebaseDocument, CodebaseSourceType } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface CodebaseCreateFormProps {
  onCreated?: (codebase: CodebaseDocument) => void;
  onCancel?: () => void;
  className?: string;
  compact?: boolean;
}

export function CodebaseCreateForm({ onCreated, onCancel, className, compact = false }: CodebaseCreateFormProps) {
  const queryClient = useQueryClient();
  const [sourceType, setSourceType] = useState<CodebaseSourceType>("git");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [source, setSource] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [description, setDescription] = useState("");

  const createMutation = useMutation({
    mutationFn: () => api.createCodebase({
      name: name.trim(),
      sourceType,
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      ...(sourceType === "git" && source.trim() ? { source: source.trim() } : {}),
      ...(sourceType === "git" && defaultBranch.trim() ? { defaultBranch: defaultBranch.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
    }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["codebases"] });
      toast.success(`Codebase "${created.slug}" created`);
      onCreated?.(created);
      setName("");
      setSlug("");
      setSource("");
      setDefaultBranch("");
      setDescription("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to create codebase"),
  });

  const sourceValid = sourceType === "archive" || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.trim());
  const canCreate = name.trim().length > 0 && sourceValid && !createMutation.isPending;

  return (
    <div className={cn("space-y-4", className)}>
      <div className={cn("grid gap-4", compact ? "grid-cols-1" : "sm:grid-cols-2")}>
        <div className="space-y-2">
          <Label htmlFor="codebase-source-type">Source type</Label>
          <Select value={sourceType} onValueChange={(value) => setSourceType(value as CodebaseSourceType)}>
            <SelectTrigger id="codebase-source-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="git">Git repository</SelectItem>
              <SelectItem value="archive">Uploaded archive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="codebase-name">Name *</Label>
          <Input id="codebase-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="scope-core" />
        </div>
      </div>

      <div className={cn("grid gap-4", compact ? "grid-cols-1" : "sm:grid-cols-2")}>
        <div className="space-y-2">
          <Label htmlFor="codebase-slug">Slug</Label>
          <Input id="codebase-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="Auto-generated" className="font-mono" />
        </div>
        {sourceType === "git" && (
          <div className="space-y-2">
            <Label htmlFor="codebase-default-branch">Default branch</Label>
            <Input id="codebase-default-branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} placeholder="main" className="font-mono" />
          </div>
        )}
      </div>

      {sourceType === "git" && (
        <div className="space-y-2">
          <Label htmlFor="codebase-source">GitHub repository *</Label>
          <Input id="codebase-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="owner/repo" className="font-mono" />
          {!sourceValid && source.trim() && <p className="text-xs text-destructive">Use owner/repo format.</p>}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="codebase-description">Description</Label>
        <Textarea id="codebase-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={compact ? 2 : 3} placeholder="What this workspace seed contains" />
        {sourceType === "archive" && (
          <p className="text-xs text-muted-foreground">After creating the archive codebase, upload its first archive from the detail page or picker.</p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
        <Button type="button" size="sm" className="gap-1.5" disabled={!canCreate} onClick={() => createMutation.mutate()}>
          {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Create codebase
        </Button>
      </div>
    </div>
  );
}
