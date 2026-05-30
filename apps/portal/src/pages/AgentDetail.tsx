// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CodingAgent, AgentVersion } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Trash2, Loader2, Save, Plus, X, Star } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { useState, useEffect } from "react";

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: agent, isLoading, error } = useQuery({
    queryKey: ["agent", id],
    queryFn: () => api.getAgent(id!),
    enabled: !!id,
  });

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [newModel, setNewModel] = useState("");

  useEffect(() => {
    if (agent) {
      setName(agent.name);
      setDescription(agent.description ?? "");
      setModels([...agent.supportedModels]);
      setDefaultModel(agent.defaultModel ?? "");
    }
  }, [agent]);

  const updateMutation = useMutation({
    mutationFn: (body: Partial<Pick<CodingAgent, 'name' | 'description' | 'supportedModels' | 'defaultModel'>>) =>
      api.updateAgent(id!, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent", id] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setEditing(false);
      toast.success("Agent updated");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteAgent(id!),
    onSuccess: () => {
      toast.success("Agent deleted");
      navigate("/agents");
    },
  });

  const handleSave = () => {
    const body: Partial<Pick<CodingAgent, 'name' | 'description' | 'supportedModels' | 'defaultModel'>> = {
      name,
      description: description.trim() || undefined,
      supportedModels: models,
      defaultModel: defaultModel || undefined,
    };
    updateMutation.mutate(body);
  };

  const handleAddModel = () => {
    const trimmed = newModel.trim();
    if (trimmed && !models.includes(trimmed)) {
      setModels([...models, trimmed]);
      if (models.length === 0) {
        setDefaultModel(trimmed);
      }
      setNewModel("");
    }
  };

  const handleRemoveModel = (model: string) => {
    const updated = models.filter((m) => m !== model);
    setModels(updated);
    if (defaultModel === model) {
      setDefaultModel(updated[0] ?? "");
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/agents")}>
          <ArrowLeft className="h-4 w-4" /> Back to Agents
        </Button>
        <div className="text-center py-12 text-muted-foreground">
          Agent not found
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Back link */}
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/agents")}>
        <ArrowLeft className="h-4 w-4" /> Back to Agents
      </Button>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{agent.name}</h1>
          <p className="text-sm text-muted-foreground font-mono">{agent._id}</p>
        </div>
        <div className="flex items-center gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="gap-1.5">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete agent?</AlertDialogTitle>
                <AlertDialogDescription>
                  This soft-deletes the agent. It can be re-seeded on next deployment.
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
      </div>

      {/* Models card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Supported Models</CardTitle>
          {!editing ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => {
                setEditing(false);
                // Reset to server state
                if (agent) {
                  setName(agent.name);
                  setDescription(agent.description ?? "");
                  setModels([...agent.supportedModels]);
                  setDefaultModel(agent.defaultModel ?? "");
                }
              }}>
                Cancel
              </Button>
              <Button size="sm" className="gap-1" onClick={handleSave} disabled={updateMutation.isPending}>
                {updateMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {editing ? (
            <>
              {/* Model list with remove buttons */}
              <div className="space-y-2">
                {models.length === 0 && (
                  <p className="text-sm text-muted-foreground">No models configured. Model selection will be disabled.</p>
                )}
                {models.map((m) => (
                  <div key={m} className="flex items-center gap-2">
                    <Badge variant={m === defaultModel ? "default" : "secondary"} className="text-xs">
                      {m}
                    </Badge>
                    {m === defaultModel && (
                      <span className="text-xs text-muted-foreground">(default)</span>
                    )}
                    {m !== defaultModel && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        title="Set as default"
                        onClick={() => setDefaultModel(m)}
                      >
                        <Star className="h-3 w-3" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive"
                      onClick={() => handleRemoveModel(m)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
              {/* Add model */}
              <div className="flex items-center gap-2">
                <Input
                  placeholder="e.g. gpt-4.1"
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddModel();
                    }
                  }}
                  className="max-w-xs"
                />
                <Button variant="outline" size="sm" className="gap-1" onClick={handleAddModel}>
                  <Plus className="h-3 w-3" /> Add
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              {agent.supportedModels.length > 0 ? (
                agent.supportedModels.map((m) => (
                  <Badge key={m} variant={m === agent.defaultModel ? "default" : "secondary"}>
                    {m}
                    {m === agent.defaultModel && (
                      <Star className="ml-1 h-3 w-3 fill-current" />
                    )}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">No models configured — model selection disabled</span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Metadata card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {editing ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Description</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description"
                  rows={2}
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Name</span>
                <p>{agent.name}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Availability</span>
                <div className="mt-1">
                  {agent.available === false ? (
                    <Badge variant="secondary">Unavailable</Badge>
                  ) : (
                    <Badge variant="default">Available</Badge>
                  )}
                </div>
              </div>
              {agent.description && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">Description</span>
                  <p>{agent.description}</p>
                </div>
              )}
              <div>
                <span className="text-muted-foreground">Created</span>
                <p>{formatDate(agent.createdAt)}</p>
              </div>
              {agent.updatedAt && (
                <div>
                  <span className="text-muted-foreground">Updated</span>
                  <p>{formatDate(agent.updatedAt)}</p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Capabilities card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Capabilities</CardTitle>
        </CardHeader>
        <CardContent>
          {(() => {
            const caps = agent.capabilities;
            const entries: { label: string; supported: boolean }[] = [
              { label: "Reasoning Effort", supported: !!caps?.supportsReasoningEffort },
            ];
            return (
              <div className="flex flex-wrap gap-2">
                {entries.map(({ label, supported }) => (
                  <Badge key={label} variant={supported ? "default" : "outline"} className="gap-1.5">
                    {supported ? (
                      <span className="text-green-400">●</span>
                    ) : (
                      <span className="text-muted-foreground">○</span>
                    )}
                    {label}
                  </Badge>
                ))}
              </div>
            );
          })()}
        </CardContent>
      </Card>

      {/* Versions card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deployed Versions</CardTitle>
        </CardHeader>
        <CardContent>
          {(() => {
            const versions = agent.versions ?? [];
            if (versions.length === 0) {
              return <p className="text-sm text-muted-foreground">No versions registered yet.</p>;
            }

            const active = versions.filter((v) => v.status === "active");
            const retired = versions.filter((v) => v.status === "retired");

            return (
              <div className="space-y-3">
                {active.map((v) => (
                  <VersionEntry key={v.agentVersion} version={v} />
                ))}
                {retired.length > 0 && (
                  <div className="space-y-2 opacity-50">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Retired</p>
                    {retired.map((v) => (
                      <VersionEntry key={v.agentVersion} version={v} />
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </CardContent>
      </Card>
    </div>
  );
}

function VersionEntry({ version }: { version: AgentVersion }) {
  const componentDisplay = Object.entries(version.components)
    .map(([key, val]) => {
      // Convert env var names to readable labels
      const label = key
        .replace(/_VERSION$/, "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      return `${label} ${val}`;
    })
    .join(", ");

  return (
    <div className="flex items-start justify-between rounded-md border p-3">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">{version.agentVersion}</span>
          <Badge variant={version.status === "active" ? "default" : "secondary"} className="text-xs">
            {version.status}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{componentDisplay}</p>
        <p className="text-xs text-muted-foreground font-mono">
          Build: {version.gitCommit} · {version.buildTime}
        </p>
        <p className="text-xs text-muted-foreground font-mono">
          Queue: {version.queueName}
        </p>
      </div>
      <span className="text-xs text-muted-foreground">{formatDate(version.createdAt)}</span>
    </div>
  );
}
