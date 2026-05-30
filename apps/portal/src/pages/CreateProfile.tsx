// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CodingAgent, McpServerDocument } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { SkillPicker } from "@/components/SkillPicker";
import { ExtensionPicker } from "@/components/ExtensionPicker";
import { useModelCapabilities, useReasoningEffort, ReasoningEffortSelect, ModelSelectItems } from "@/components/ReasoningEffortSelect";
import { ArrowLeft, Loader2, Save, Zap } from "lucide-react";
import { toast } from "sonner";

export function CreateProfile() {
  const navigate = useNavigate();

  // Identity fields
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // Configuration fields
  const [worker, setWorker] = useState("");
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [selectedAgentVersion, setSelectedAgentVersion] = useState("");
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>([]);

  // Fetch agents (workers)
  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
  });

  // Fetch MCP servers
  const { data: mcpServers = [] } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: api.listMcpServers,
  });

  // Find selected agent for model/version lists
  const selectedAgent = agents.find((a: CodingAgent) => a._id === worker);
  const supportedModels = selectedAgent?.supportedModels ?? [];
  const isVscodeWorker = worker.includes("vscode");

  // Model capabilities and effort management
  const { capabilitiesMap } = useModelCapabilities(worker || undefined);
  const onEffortChange = useCallback((v: string) => setReasoningEffort(v), []);
  const { supportedEfforts } = useReasoningEffort({
    model,
    capabilitiesMap,
    value: reasoningEffort,
    onChange: onEffortChange,
  });

  // Clear extensions when the user switches to a non-vscode worker.
  useEffect(() => {
    if (worker && !isVscodeWorker) {
      setSelectedExtensions([]);
    }
  }, [worker, isVscodeWorker]);

  // Fetch agent versions
  const { data: agentVersions = [] } = useQuery({
    queryKey: ["agent-versions", worker],
    queryFn: () => api.listAgentVersions(worker),
    enabled: !!worker,
  });

  const sortedVersions = [...agentVersions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // Auto-select latest agent version when versions load
  useEffect(() => {
    if (sortedVersions.length > 0 && !selectedAgentVersion) {
      setSelectedAgentVersion(sortedVersions[0].agentVersion);
    }
  }, [sortedVersions.length]);

  const createMutation = useMutation({
    mutationFn: () => api.createProfile({
      name,
      ...(description ? { description } : {}),
      workerType: worker,
      model,
      reasoningEffort: reasoningEffort || "default",
      ...(selectedAgentVersion ? { agentVersion: selectedAgentVersion } : {}),
      ...(selectedMcpServers.length > 0 ? { mcpServers: selectedMcpServers } : {}),
      ...(selectedSkills.length > 0 ? { skillRevisions: selectedSkills } : {}),
      ...(selectedExtensions.length > 0 ? { extensions: selectedExtensions } : {}),
    }),
    onSuccess: (data) => {
      const profileId = "_id" in data ? data._id : (data as { profileId: string }).profileId;
      toast.success(`Profile "${name}" created`);
      navigate(`/profiles/${profileId}`);
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

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/profiles")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Create Profile</h1>
          <p className="text-muted-foreground">
            Save a reusable run configuration for reproducible benchmarking.
          </p>
        </div>
      </div>

      {/* Identity */}
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
            {description.length > 512 && <p className="text-xs text-destructive">Description must be 512 characters or fewer</p>}
          </div>
        </CardContent>
      </Card>

      {/* Agent Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Agent Configuration</CardTitle>
          <CardDescription>Worker, model, and agent version</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="worker">Worker *</Label>
            <Select value={worker} onValueChange={(v) => { setWorker(v); setModel(""); setSelectedAgentVersion(""); }}>
              <SelectTrigger id="worker">
                <SelectValue placeholder="Select a worker" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a: CodingAgent) => (
                  <SelectItem key={a._id} value={a._id}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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

      {/* MCP Servers */}
      {mcpServers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>MCP Servers</CardTitle>
            <CardDescription>Select MCP servers to include in this profile</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {mcpServers.map((s: McpServerDocument) => (
                <div key={s._id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`mcp-${s._id}`}
                    checked={selectedMcpServers.includes(s._id)}
                    onCheckedChange={(checked) => {
                      setSelectedMcpServers((prev) =>
                        checked ? [...prev, s._id] : prev.filter((id) => id !== s._id)
                      );
                    }}
                  />
                  <Label htmlFor={`mcp-${s._id}`} className="font-mono text-sm">{s._id}</Label>
                  <span className="text-muted-foreground text-xs">{s.name}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Skills */}
      <Card>
        <CardHeader>
          <CardTitle>Skills</CardTitle>
          <CardDescription>Select skills to include — pinned to their current revision</CardDescription>
        </CardHeader>
        <CardContent>
          <SkillPicker selected={selectedSkills} onChange={setSelectedSkills} />
        </CardContent>
      </Card>

      {/* Extensions (VS Code workers only) */}
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

      {/* Save */}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate("/profiles")}>
          Cancel
        </Button>
        <Button
          onClick={() => createMutation.mutate()}
          disabled={!canSubmit || createMutation.isPending}
        >
          {createMutation.isPending ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating...</>
          ) : (
            <><Save className="mr-2 h-4 w-4" /> Create Profile</>
          )}
        </Button>
      </div>
    </div>
  );
}
