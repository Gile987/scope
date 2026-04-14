// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useEffect } from "react";
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
import { ArrowLeft, Loader2, Save, Zap } from "lucide-react";
import { toast } from "sonner";

interface CreateProfilePageProps {
  /** If provided, pre-fills form from an existing profile version for edit-as-new-version */
  editProfileId?: string;
}

export function CreateProfile({ editProfileId }: CreateProfilePageProps = {}) {
  const navigate = useNavigate();

  // Identity fields
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  // Configuration fields (same as SubmitRun)
  const [worker, setWorker] = useState("");
  const [model, setModel] = useState("");
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

  // When editing, pre-fill from the existing profile
  const { data: existingProfile } = useQuery({
    queryKey: ["profile", editProfileId],
    queryFn: () => api.getProfile(editProfileId!),
    enabled: !!editProfileId,
  });

  useEffect(() => {
    if (existingProfile) {
      setName(existingProfile.name);
      setDescription(existingProfile.description ?? "");
      setWorker(existingProfile.version.workerType);
      setModel(existingProfile.version.model);
      setSelectedAgentVersion(existingProfile.version.agentVersion ?? "");
      setSelectedMcpServers(existingProfile.version.mcpServers ?? []);
      setSelectedSkills(existingProfile.version.skillRevisions ?? []);
      setSelectedExtensions(existingProfile.version.extensions ?? []);
    }
  }, [existingProfile]);

  // Find selected agent for model/version lists
  const selectedAgent = agents.find((a: CodingAgent) => a._id === worker);
  const supportedModels = selectedAgent?.supportedModels ?? [];
  const isVscodeWorker = worker.includes("vscode");

  // Clear extensions when the user switches to a non-vscode worker.
  // Skip when worker is empty (initial state before profile loads).
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
    if (sortedVersions.length > 0 && !selectedAgentVersion && !editProfileId) {
      setSelectedAgentVersion(sortedVersions[0].agentVersion);
    }
  }, [sortedVersions.length]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name,
        ...(description ? { description } : {}),
        workerType: worker,
        model,
        ...(selectedAgentVersion ? { agentVersion: selectedAgentVersion } : {}),
        ...(selectedMcpServers.length > 0 ? { mcpServers: selectedMcpServers } : {}),
        ...(selectedSkills.length > 0 ? { skillRevisions: selectedSkills } : {}),
        ...(selectedExtensions.length > 0 ? { extensions: selectedExtensions } : {}),
      };

      if (editProfileId) {
        // Create new version of existing profile
        const { name: _, description: __, ...versionBody } = body;
        return api.createProfileVersion(editProfileId, versionBody);
      }
      return api.createProfile(body);
    },
    onSuccess: (data) => {
      const profileId = editProfileId ?? ("_id" in data ? data._id : (data as { profileId: string }).profileId);
      if (editProfileId) {
        toast.success(`Created version ${(data as { version: number }).version} of profile`);
      } else {
        toast.success(`Profile "${name}" created`);
      }
      navigate(`/profiles/${profileId}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to save profile");
    },
  });

  const generateIdentity = () => {
    const parts: string[] = [];
    const descParts: string[] = [];

    // Worker — use agent name if available, else raw ID
    const agentName = selectedAgent?.name ?? worker;
    if (agentName) {
      const workerLabel = selectedAgentVersion ? `${agentName}@${selectedAgentVersion}` : agentName;
      parts.push(workerLabel);
      descParts.push(workerLabel);
    }

    // Model
    if (model) {
      parts.push(model);
      descParts.push(`model: ${model}`);
    }

    // MCP servers
    if (selectedMcpServers.length > 0) {
      parts.push(selectedMcpServers.join(", "));
      descParts.push(`MCP: ${selectedMcpServers.join(", ")}`);
    }

    // Skills — keep full slug (may contain version info)
    if (selectedSkills.length > 0) {
      const shortSkills = selectedSkills.map((s) => s.split("/").pop() ?? s);
      parts.push(shortSkills.join(", "));
      descParts.push(`Skills: ${selectedSkills.join(", ")}`);
    }

    // Extensions — keep version suffix when present
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
        <Button variant="ghost" size="icon" onClick={() => navigate(editProfileId ? `/profiles/${editProfileId}` : "/profiles")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">
            {editProfileId ? "New Profile Version" : "Create Profile"}
          </h1>
          <p className="text-muted-foreground">
            {editProfileId
              ? "Editing creates a new immutable version. The original version is preserved."
              : "Save a reusable run configuration for reproducible benchmarking."}
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
            {!editProfileId && worker && (
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
              disabled={!!editProfileId}
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
              disabled={!!editProfileId}
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
                  {supportedModels.map((m: string) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

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
        <Button variant="outline" onClick={() => navigate(editProfileId ? `/profiles/${editProfileId}` : "/profiles")}>
          Cancel
        </Button>
        <Button
          onClick={() => createMutation.mutate()}
          disabled={!canSubmit || createMutation.isPending}
        >
          {createMutation.isPending ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...</>
          ) : (
            <><Save className="mr-2 h-4 w-4" /> {editProfileId ? "Create New Version" : "Create Profile"}</>
          )}
        </Button>
      </div>
    </div>
  );
}
