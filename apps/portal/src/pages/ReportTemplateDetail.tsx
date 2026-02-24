// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { api } from "@/lib/api";
import type { ReportTrigger } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Save, Trash2, Loader2 } from "lucide-react";
import { formatDate } from "@/lib/utils";

function triggerSummary(trigger?: ReportTrigger): string {
  if (!trigger) return "always (no trigger configured)";
  switch (trigger.type) {
    case "always": return "always";
    case "criteria":
      return `criteria: ${trigger.criteriaIds.join(", ")} (match: ${trigger.match ?? "all"})`;
    case "taskPrompt":
      return `taskPrompt: ${trigger.taskPromptIds.join(", ")}`;
    case "promptFeature":
      return `promptFeature: ${trigger.featureIds.join(", ")} (match: ${trigger.match ?? "all"})`;
    default:
      return "unknown";
  }
}

export function ReportTemplateDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: template, isLoading, error } = useQuery({
    queryKey: ["report-template", id],
    queryFn: () => api.getReportTemplate(id!),
    enabled: !!id,
  });

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editUserPrompt, setEditUserPrompt] = useState("");
  const [editSysMode, setEditSysMode] = useState<"none" | "append" | "override">("none");
  const [editSysContent, setEditSysContent] = useState("");
  const [editTriggerType, setEditTriggerType] = useState<"always" | "criteria" | "taskPrompt" | "promptFeature">("always");
  const [editTriggerIds, setEditTriggerIds] = useState("");
  const [editTriggerMatch, setEditTriggerMatch] = useState<"any" | "all">("all");

  const startEditing = () => {
    if (!template) return;
    setEditName(template.name);
    setEditDescription(template.description ?? "");
    setEditUserPrompt(template.userPrompt);
    setEditSysMode(template.systemPrompt?.mode ?? "none");
    setEditSysContent(template.systemPrompt?.content ?? "");
    setEditTriggerType(template.trigger?.type ?? "always");
    setEditTriggerIds(getTriggerIds(template.trigger).join(", "));
    setEditTriggerMatch(
      (template.trigger?.type === "criteria" || template.trigger?.type === "promptFeature")
        ? (template.trigger as any).match ?? "all"
        : "all"
    );
    setEditing(true);
  };

  const updateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.updateReportTemplate(id!, body),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["report-template", id] });
      queryClient.invalidateQueries({ queryKey: ["report-templates"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteReportTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["report-templates"] });
      navigate("/report-templates");
    },
  });

  const handleSave = () => {
    const body: Record<string, unknown> = {};
    if (editName.trim()) body.name = editName.trim();
    body.description = editDescription.trim() || undefined;
    if (editUserPrompt.trim()) body.userPrompt = editUserPrompt.trim();

    // System prompt
    if (editSysMode !== "none" && editSysContent.trim()) {
      body.systemPrompt = { mode: editSysMode, content: editSysContent.trim() };
    } else {
      body.systemPrompt = null; // Remove system prompt
    }

    // Trigger
    if (editTriggerType === "always") {
      body.trigger = { type: "always" };
    } else {
      const idsArray = editTriggerIds.split(",").map(s => s.trim()).filter(Boolean);
      if (editTriggerType === "criteria") {
        body.trigger = { type: "criteria", criteriaIds: idsArray, match: editTriggerMatch };
      } else if (editTriggerType === "taskPrompt") {
        body.trigger = { type: "taskPrompt", taskPromptIds: idsArray };
      } else if (editTriggerType === "promptFeature") {
        body.trigger = { type: "promptFeature", featureIds: idsArray, match: editTriggerMatch };
      }
    }

    updateMutation.mutate(body);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error || !template) {
    return (
      <div className="space-y-4">
        <Link to="/report-templates" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to templates
        </Link>
        <div className="text-center py-12 text-muted-foreground">
          Template not found
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/report-templates" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{template.name}</h1>
            <p className="font-mono text-sm text-muted-foreground">{template.id}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!editing && (
            <Button variant="outline" onClick={startEditing}>Edit</Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="gap-1.5">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete template?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete <strong>{template.id}</strong>. Existing reports will not be affected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate(template.id)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {editing ? (
        /* ── Edit mode ────────────────────────────────────────────── */
        <Card>
          <CardHeader>
            <CardTitle>Edit Template</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input id="description" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} placeholder="Optional description" />
            </div>
            <Separator />
            <div className="space-y-2">
              <Label htmlFor="userPrompt">User Prompt</Label>
              <Textarea id="userPrompt" value={editUserPrompt} onChange={(e) => setEditUserPrompt(e.target.value)} rows={12} className="font-mono text-sm" />
              <p className="text-xs text-muted-foreground">Use {"{{requestId}}"} as a placeholder for the run ID. The user prompt takes precedence over the default report structure.</p>
            </div>
            <Separator />
            <div className="space-y-2">
              <Label>System Prompt</Label>
              <Select value={editSysMode} onValueChange={(v) => setEditSysMode(v as "none" | "append" | "override")}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (use default)</SelectItem>
                  <SelectItem value="append">Append</SelectItem>
                  <SelectItem value="override">Override</SelectItem>
                </SelectContent>
              </Select>
              {editSysMode !== "none" && (
                <Textarea value={editSysContent} onChange={(e) => setEditSysContent(e.target.value)} rows={4} className="font-mono text-sm" placeholder="System prompt content..." />
              )}
            </div>
            <Separator />
            <div className="space-y-2">
              <Label>Trigger</Label>
              <Select value={editTriggerType} onValueChange={(v) => setEditTriggerType(v as any)}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">Always</SelectItem>
                  <SelectItem value="criteria">Criteria</SelectItem>
                  <SelectItem value="taskPrompt">Task Prompt</SelectItem>
                  <SelectItem value="promptFeature">Prompt Feature</SelectItem>
                </SelectContent>
              </Select>
              {editTriggerType !== "always" && (
                <>
                  <Input
                    value={editTriggerIds}
                    onChange={(e) => setEditTriggerIds(e.target.value)}
                    placeholder={editTriggerType === "criteria" ? "criteria_id_1, criteria_id_2" : editTriggerType === "taskPrompt" ? "task-prompt-id-1, task-prompt-id-2" : "feature_id_1, feature_id_2"}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">Comma-separated IDs</p>
                </>
              )}
              {(editTriggerType === "criteria" || editTriggerType === "promptFeature") && (
                <Select value={editTriggerMatch} onValueChange={(v) => setEditTriggerMatch(v as "any" | "all")}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Match all</SelectItem>
                    <SelectItem value="any">Match any</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            <Separator />
            <div className="flex gap-2">
              <Button onClick={handleSave} disabled={updateMutation.isPending} className="gap-1.5">
                {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
            {updateMutation.isError && (
              <p className="text-sm text-destructive">
                Failed to update: {updateMutation.error instanceof Error ? updateMutation.error.message : "Unknown error"}
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        /* ── View mode ────────────────────────────────────────────── */
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-muted-foreground text-xs">Name</Label>
                <p className="text-sm">{template.name}</p>
              </div>
              {template.description && (
                <div>
                  <Label className="text-muted-foreground text-xs">Description</Label>
                  <p className="text-sm">{template.description}</p>
                </div>
              )}
              <div>
                <Label className="text-muted-foreground text-xs">Trigger</Label>
                <div className="mt-1">
                  <Badge variant="secondary" className="text-xs font-mono">
                    {triggerSummary(template.trigger)}
                  </Badge>
                </div>
              </div>
              <Separator />
              <div className="flex gap-6 text-xs text-muted-foreground">
                <span>Created: {formatDate(template.createdAt)}</span>
                {template.updatedAt && <span>Updated: {formatDate(template.updatedAt)}</span>}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>User Prompt</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm dark:prose-invert max-w-none bg-muted p-3 rounded-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{template.userPrompt}</ReactMarkdown>
              </div>
            </CardContent>
          </Card>

          {template.systemPrompt && (
            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle>
                  System Prompt{" "}
                  <Badge variant="outline" className="ml-2 text-xs">
                    {template.systemPrompt.mode}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="prose prose-sm dark:prose-invert max-w-none bg-muted p-3 rounded-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{template.systemPrompt.content}</ReactMarkdown>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function getTriggerIds(trigger?: ReportTrigger): string[] {
  if (!trigger) return [];
  switch (trigger.type) {
    case "criteria": return trigger.criteriaIds;
    case "taskPrompt": return trigger.taskPromptIds;
    case "promptFeature": return trigger.featureIds;
    default: return [];
  }
}
