// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Plus, Save, Zap } from "lucide-react";
import { toast } from "sonner";

import { ExtensionPicker } from "@/components/ExtensionPicker";
import { SkillPicker } from "@/components/SkillPicker";
import { McpServerCreateDialog } from "@/components/McpServerCreateDialog";
import {
  ModelSelectItems,
  ReasoningEffortSelect,
  useModelCapabilities,
  useReasoningEffort,
} from "@/components/ReasoningEffortSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { CodingAgent, McpServerDocument, ProfileWithVersion } from "@/types";

interface ProfileCreateFormProps {
  onCreated: (profile: ProfileWithVersion) => void;
  onCancel?: () => void;
  className?: string;
  showCancel?: boolean;
  stickyFooter?: boolean;
}

export function ProfileCreateForm({
  onCreated,
  onCancel,
  className,
  showCancel = true,
  stickyFooter = false,
}: ProfileCreateFormProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [worker, setWorker] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [selectedAgentVersion, setSelectedAgentVersion] = useState("");
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>([]);
  const [createMcpOpen, setCreateMcpOpen] = useState(false);

  const queryClient = useQueryClient();

  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
  });

  const { data: mcpServers = [] } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: api.listMcpServers,
  });

  const selectedAgent = agents.find((a: CodingAgent) => a._id === worker);
  const supportedModels = selectedAgent?.supportedModels ?? [];
  const isVscodeWorker = worker.includes("vscode");

  const { capabilitiesMap } = useModelCapabilities(worker || undefined);
  const onEffortChange = useCallback((v: string) => setReasoningEffort(v), []);
  const { supportedEfforts } = useReasoningEffort({
    model,
    capabilitiesMap,
    value: reasoningEffort,
    onChange: onEffortChange,
  });

  const eligibleAgents = agents.filter(
    (a: CodingAgent) => Array.isArray(a.supportedModels) && a.supportedModels.length > 0,
  );

  useEffect(() => {
    if (worker && !isVscodeWorker) {
      setSelectedExtensions([]);
    }
  }, [worker, isVscodeWorker]);

  const { data: agentVersions = [] } = useQuery({
    queryKey: ["agent-versions", worker],
    queryFn: () => api.listAgentVersions(worker),
    enabled: !!worker,
  });

  const sortedVersions = [...agentVersions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  useEffect(() => {
    if (sortedVersions.length > 0 && !selectedAgentVersion) {
      setSelectedAgentVersion(sortedVersions[0].agentVersion);
    }
  }, [selectedAgentVersion, sortedVersions]);

  const createMutation = useMutation({
    mutationFn: () =>
      api.createProfile({
        name,
        ...(description ? { description } : {}),
        workerType: worker,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(selectedAgentVersion ? { agentVersion: selectedAgentVersion } : {}),
        ...(selectedMcpServers.length > 0 ? { mcpServers: selectedMcpServers } : {}),
        ...(selectedSkills.length > 0 ? { skillRevisions: selectedSkills } : {}),
        ...(selectedExtensions.length > 0 ? { extensions: selectedExtensions } : {}),
      }),
    onSuccess: (profile) => {
      toast.success(`Profile "${profile.name}" created`);
      onCreated(profile);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to create profile");
    },
  });

  const generateIdentity = () => {
    const parts: string[] = [];
    const descParts: string[] = [];

    const agentName = selectedAgent?.name ?? worker;
    if (agentName) {
      const workerLabel = selectedAgentVersion ? `${agentName}@${selectedAgentVersion}` : agentName;
      parts.push(workerLabel);
      descParts.push(workerLabel);
    }
    if (model) {
      const modelLabel = reasoningEffort ? `${model} (${reasoningEffort})` : model;
      parts.push(modelLabel);
      descParts.push(`model: ${modelLabel}`);
    }
    if (selectedMcpServers.length > 0) {
      parts.push(selectedMcpServers.join(", "));
      descParts.push(`MCP: ${selectedMcpServers.join(", ")}`);
    }
    if (selectedSkills.length > 0) {
      const shortSkills = selectedSkills.map((s) => s.split("/").pop() ?? s);
      parts.push(shortSkills.join(", "));
      descParts.push(`Skills: ${selectedSkills.join(", ")}`);
    }
    if (selectedExtensions.length > 0) {
      const shortExts = selectedExtensions.map((e) => e.split("/").pop() ?? e);
      parts.push(shortExts.join(", "));
      descParts.push(`Extensions: ${selectedExtensions.join(", ")}`);
    }

    setName(parts.join(" + ").slice(0, 128));
    setDescription(descParts.join(". ").slice(0, 512));
  };

  const canSubmit = name.trim() && name.length <= 128 && description.length <= 512 && worker && model;

  const handleMcpServerCreated = (server: McpServerDocument) => {
    queryClient.setQueryData<McpServerDocument[]>(["mcp-servers"], (previous) => {
      const existing = previous ?? [];
      if (existing.some((item) => item._id === server._id)) {
        return existing.map((item) => (item._id === server._id ? server : item));
      }
      return [server, ...existing];
    });
    void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    setSelectedMcpServers((prev) => (prev.includes(server._id) ? prev : [...prev, server._id]));
    setCreateMcpOpen(false);
  };

  return (
    <div className={className ? `space-y-6 ${className}` : "space-y-6"}>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Identity</CardTitle>
              <CardDescription>Name and description for this profile</CardDescription>
            </div>
            {worker && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={generateIdentity}
              >
                <Zap className="h-3.5 w-3.5" />
                Auto-fill
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="name">Name *</Label>
              {name.length > 128 && <span className="text-xs text-destructive">{name.length}/128</span>}
            </div>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Azure Skills + Learn MCP"
              className={name.length > 128 ? "border-destructive" : undefined}
            />
            {name.length > 128 && <p className="text-xs text-destructive">Name must be 128 characters or fewer</p>}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="description">Description</Label>
              {description.length > 512 && <span className="text-xs text-destructive">{description.length}/512</span>}
            </div>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={2}
              className={description.length > 512 ? "border-destructive" : undefined}
            />
            {description.length > 512 && (
              <p className="text-xs text-destructive">Description must be 512 characters or fewer</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent Configuration</CardTitle>
          <CardDescription>Worker, model, and agent version</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="worker">Worker *</Label>
            <Select value={worker} onValueChange={(value) => { setWorker(value); setModel(""); setSelectedAgentVersion(""); }}>
              <SelectTrigger id="worker">
                <SelectValue placeholder="Select a worker" />
              </SelectTrigger>
              <SelectContent>
                {eligibleAgents.map((a: CodingAgent) => (
                  <SelectItem key={a._id} value={a._id}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {eligibleAgents.length < agents.length && (
              <p className="text-xs text-muted-foreground">
                Agents without selectable models are hidden — a profile requires a model.
              </p>
            )}
          </div>

          {supportedModels.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="model">Model *</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="model">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  <ModelSelectItems
                    models={supportedModels}
                    capabilitiesMap={capabilitiesMap}
                  />
                </SelectContent>
              </Select>
            </div>
          )}

          <ReasoningEffortSelect
            supportedEfforts={supportedEfforts}
            value={reasoningEffort}
            onChange={onEffortChange}
          />

          {sortedVersions.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="agentVersion">Agent Version</Label>
              <Select value={selectedAgentVersion} onValueChange={setSelectedAgentVersion}>
                <SelectTrigger id="agentVersion">
                  <SelectValue placeholder="Select version" />
                </SelectTrigger>
                <SelectContent>
                  {sortedVersions.map((v, i) => (
                    <SelectItem key={v.agentVersion} value={v.agentVersion}>
                      {v.agentVersion}{i === 0 ? " (latest)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>MCP Servers</CardTitle>
              <CardDescription>Select MCP servers to include in this profile</CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setCreateMcpOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              New MCP server…
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {mcpServers.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              No MCP servers configured yet. Create one to attach it to this profile.
            </p>
          ) : (
            <div className="space-y-2">
              {mcpServers.map((s: McpServerDocument) => (
                <div key={s._id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`mcp-${s._id}`}
                    checked={selectedMcpServers.includes(s._id)}
                    onCheckedChange={(checked) => {
                      setSelectedMcpServers((prev) => (
                        checked ? [...prev, s._id] : prev.filter((id) => id !== s._id)
                      ));
                    }}
                  />
                  <Label htmlFor={`mcp-${s._id}`} className="font-mono text-sm">{s._id}</Label>
                  <span className="text-muted-foreground text-xs">{s.name}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <McpServerCreateDialog
        open={createMcpOpen}
        onOpenChange={setCreateMcpOpen}
        onCreated={handleMcpServerCreated}
      />


      <Card>
        <CardHeader>
          <CardTitle>Skills</CardTitle>
          <CardDescription>Select skills to include — pinned to their current revision</CardDescription>
        </CardHeader>
        <CardContent>
          <SkillPicker selected={selectedSkills} onChange={setSelectedSkills} />
        </CardContent>
      </Card>

      {isVscodeWorker && (
        <Card>
          <CardHeader>
            <CardTitle>Extensions</CardTitle>
            <CardDescription>Select VS Code extensions — pinned to their current marketplace version</CardDescription>
          </CardHeader>
          <CardContent>
            <ExtensionPicker selected={selectedExtensions} onChange={setSelectedExtensions} />
          </CardContent>
        </Card>
      )}

      <div
        className={
          stickyFooter
            ? "sticky bottom-0 -mx-6 mt-6 flex justify-end gap-2 border-t bg-background/95 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80"
            : "flex justify-end gap-2"
        }
      >
        {showCancel && onCancel && (
          <Button variant="outline" onClick={onCancel}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Cancel
          </Button>
        )}
        <Button
          onClick={() => createMutation.mutate()}
          disabled={!canSubmit || createMutation.isPending}
        >
          {createMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              Create Profile
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
