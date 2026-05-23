// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Send, Loader2, Server, Info, BookOpen, Sparkles, Puzzle, SlidersHorizontal,
  X, Save, Plus, ChevronDown, FilePlus2, History, ArrowLeft,
} from "lucide-react";
import {
  WORKER_TYPES, type CodingAgent, type McpServerDocument,
  type ProfileWithVersion, type ProfileVersionDocument, type Run,
} from "@/types";
import { Checkbox } from "@/components/ui/checkbox";
import { CriteriaPicker } from "@/components/CriteriaPicker";
import { CreateCriterionDialog } from "@/components/CreateCriterionDialog";
import { SkillPicker } from "@/components/SkillPicker";
import { ExtensionPicker } from "@/components/ExtensionPicker";
import { TaskPromptPicker } from "@/components/TaskPromptPicker";
import { useCommandEnter } from "@/hooks/useCommandEnter";
import { KbdBadge } from "@/components/KbdBadge";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function truncate(text: string, n: number) {
  return text.length > n ? text.slice(0, n - 1).trimEnd() + "…" : text;
}

interface GalleryCardProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  onClick: () => void;
}

function GalleryCard({ icon: Icon, title, description, onClick }: GalleryCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start gap-2 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-5 w-5 text-muted-foreground transition-colors group-hover:text-primary" />
      <div className="min-w-0 w-full">
        <p className="truncate text-sm font-medium">{title}</p>
        {description && (
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        )}
      </div>
    </button>
  );
}

interface CollapsibleCardProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  summary: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
}

function CollapsibleCard({ icon: Icon, title, summary, open, onOpenChange, disabled, children }: CollapsibleCardProps) {
  return (
    <Card>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center justify-between gap-3 p-6 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-base font-semibold">
              {title}{" "}
              <span className="text-xs font-normal text-muted-foreground">(optional)</span>
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {summary}
              {disabled && " — locked by profile"}
            </p>
          </div>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <CardContent className="pt-0">
          {children}
        </CardContent>
      )}
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SubmitRun
// ────────────────────────────────────────────────────────────────────────────

export function SubmitRun() {
  const navigate = useNavigate();

  // Form state
  const [task, setTask] = useState("");
  const [pickedCriteria, setPickedCriteria] = useState<string[]>([]);
  const [worker, setWorker] = useState<string>("coder-acp-copilot");
  const [model, setModel] = useState<string>("");
  const [maxIterations, setMaxIterations] = useState<number>(10);
  const [occurrences, setOccurrences] = useState<number>(5);
  const [priority, setPriority] = useState<number>(0);

  // Optional add-ons
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>([]);

  // Profile
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedProfileVersion, setSelectedProfileVersion] = useState<number | null>(null);
  const profileLocked = !!selectedProfileId;

  // Agent version
  const [selectedAgentVersion, setSelectedAgentVersion] = useState<string>("");

  // Inline criteria creation dialog
  const [createCriterionOpen, setCreateCriterionOpen] = useState(false);

  // Save as Profile
  const [saveProfileName, setSaveProfileName] = useState("");
  const [saveProfileOpen, setSaveProfileOpen] = useState(false);

  // UI state
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);

  // AI generation
  const [showGenerate, setShowGenerate] = useState(false);
  const [generateDescription, setGenerateDescription] = useState("");

  // ─── Queries ────────────────────────────────────────────────────────────
  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.listAgents(),
  });

  const { data: mcpServers = [] } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.listMcpServers(),
  });

  const { data: profiles = [] } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });

  const { data: profileVersions = [] } = useQuery({
    queryKey: ["profile-versions", selectedProfileId],
    queryFn: () => api.listProfileVersions(selectedProfileId!),
    enabled: !!selectedProfileId,
  });

  const { data: recentRunsResp } = useQuery({
    queryKey: ["recent-runs", "submit-gallery"],
    queryFn: () => api.listRuns({ limit: 3 }),
  });
  const recentRuns: Run[] = recentRunsResp?.data ?? [];

  // ─── Derived ────────────────────────────────────────────────────────────
  const activeMcpServers = mcpServers.filter((s: McpServerDocument) => !s.deletedAt);
  const activeAgents = agents.filter((a: CodingAgent) => !a.deletedAt);
  const availableAgents = activeAgents.filter((a: CodingAgent) => a.available !== false);
  const selectedAgent = activeAgents.find((a: CodingAgent) => a._id === worker);
  const isVscodeWorker = worker.includes("vscode");
  const profileList = profiles as ProfileWithVersion[];
  const topProfiles = profileList.slice(0, 3);

  // ─── Effects ────────────────────────────────────────────────────────────
  // When agent changes, reset model + clear extensions for non-vscode workers
  useEffect(() => {
    if (selectedProfileId) return;
    if (selectedAgent) {
      setModel(selectedAgent.defaultModel ?? "");
    } else {
      setModel("");
    }
    if (!worker.includes("vscode")) {
      setSelectedExtensions([]);
    }
  }, [worker, selectedAgent?.defaultModel]);

  // Auto-open Extensions section when switching to a VS Code worker that has selected extensions
  useEffect(() => {
    if (isVscodeWorker && selectedExtensions.length > 0) {
      setExtensionsOpen(true);
    }
  }, [isVscodeWorker, selectedExtensions.length]);

  // Fetch active versions for selected agent
  const { data: agentVersions = [] } = useQuery({
    queryKey: ["agent-versions", worker],
    queryFn: () => api.listAgentVersions(worker, "active"),
    enabled: !!worker,
  });

  const sortedVersions = [...agentVersions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  useEffect(() => {
    if (selectedProfileId) return;
    if (sortedVersions.length > 0) {
      setSelectedAgentVersion(sortedVersions[0].agentVersion);
    } else {
      setSelectedAgentVersion("");
    }
  }, [worker, agentVersions.length]);

  // ─── Handlers ───────────────────────────────────────────────────────────
  const applyVersionConfig = (v: ProfileVersionDocument) => {
    setWorker(v.workerType);
    setModel(v.model);
    setSelectedAgentVersion(v.agentVersion ?? "");
    setSelectedMcpServers(v.mcpServers ?? []);
    setSelectedSkills(v.skillRevisions ?? []);
    setSelectedExtensions(v.extensions ?? []);
    if ((v.mcpServers ?? []).length > 0) setMcpOpen(true);
    if ((v.skillRevisions ?? []).length > 0) setSkillsOpen(true);
    if ((v.extensions ?? []).length > 0) setExtensionsOpen(true);
  };

  const applyProfile = (profileId: string | null) => {
    setSelectedProfileId(profileId);
    setGalleryOpen(false);
    if (!profileId) return;
    const p = profileList.find((p) => p._id === profileId);
    if (!p?.version) return;
    setSelectedProfileVersion(p.version.version);
    applyVersionConfig(p.version);
  };

  const changeProfileVersion = (version: number) => {
    setSelectedProfileVersion(version);
    const v = profileVersions.find((pv: ProfileVersionDocument) => pv.version === version);
    if (v) applyVersionConfig(v);
  };

  const clearProfile = () => {
    setSelectedProfileId(null);
    setSelectedProfileVersion(null);
  };

  const applyRecentRun = (run: Run) => {
    if (run.scenario?.task) setTask(run.scenario.task);
    if (run.scenario?.criteria) setPickedCriteria(run.scenario.criteria);
    setWorker(run.workerType);
    if (run.model) setModel(run.model);
    if (run.agentVersion) setSelectedAgentVersion(run.agentVersion);
    if (run.maxIterations) setMaxIterations(run.maxIterations);
    if (run.mcpServers && run.mcpServers.length > 0) {
      setSelectedMcpServers(run.mcpServers);
      setMcpOpen(true);
    }
    const skills = run.skillRevisions ?? run.skills ?? [];
    if (skills.length > 0) {
      setSelectedSkills(skills);
      setSkillsOpen(true);
    }
    if (run.extensions && run.extensions.length > 0) {
      setSelectedExtensions(run.extensions);
      setExtensionsOpen(true);
    }
    setGalleryOpen(false);
    toast.success(`Loaded settings from run ${run._id.slice(-6)}`);
  };

  const saveProfileMutation = useMutation({
    mutationFn: () =>
      api.createProfile({
        name: saveProfileName.trim(),
        workerType: worker,
        model,
        ...(selectedAgentVersion ? { agentVersion: selectedAgentVersion } : {}),
        ...(selectedMcpServers.length > 0 ? { mcpServers: selectedMcpServers } : {}),
        ...(selectedSkills.length > 0 ? { skillRevisions: selectedSkills } : {}),
        ...(selectedExtensions.length > 0 ? { extensions: selectedExtensions } : {}),
      }),
    onSuccess: (data) => {
      toast.success(`Profile "${saveProfileName}" saved`);
      setSaveProfileOpen(false);
      setSaveProfileName("");
      setSelectedProfileId(data._id);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to save profile");
    },
  });

  const generateMutation = useMutation({
    mutationFn: (opts: { description?: string; existingPrompt?: string }) =>
      api.generateTaskPrompt(opts),
    onSuccess: (data) => {
      setTask(data.taskPrompt);
      setShowGenerate(false);
      setGenerateDescription("");
    },
  });

  const handleGenerate = () => {
    if (task.trim()) {
      generateMutation.mutate({
        existingPrompt: task.trim(),
        ...(generateDescription.trim() && { description: generateDescription.trim() }),
      });
    } else {
      generateMutation.mutate({
        ...(generateDescription.trim() && { description: generateDescription.trim() }),
      });
    }
  };

  const submitMutation = useMutation({
    mutationFn: api.submitRun,
    onSuccess: (data) => {
      if ("ids" in data && data.ids.length > 1) {
        navigate("/runs");
      } else if ("id" in data) {
        navigate(`/runs/${data.id}`);
      } else {
        navigate("/runs");
      }
    },
  });

  const doSubmit = () => {
    if (!task.trim()) return;
    submitMutation.mutate({
      scenario: { task: task.trim(), criteria: pickedCriteria },
      worker,
      ...(model ? { model } : {}),
      maxIterations,
      ...(priority !== 0 ? { priority } : {}),
      ...(occurrences > 1 ? { count: occurrences } : {}),
      ...(selectedMcpServers.length > 0 ? { mcpServers: selectedMcpServers } : {}),
      ...(selectedSkills.length > 0 ? { skills: selectedSkills } : {}),
      ...(selectedExtensions.length > 0 ? { extensions: selectedExtensions } : {}),
      ...(selectedAgentVersion ? { agentVersion: selectedAgentVersion } : {}),
      ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
      ...(selectedProfileId && selectedProfileVersion ? {
        profileVersionId: profileVersions.find((pv: ProfileVersionDocument) => pv.version === selectedProfileVersion)?._id
          ?? profileList.find((p) => p._id === selectedProfileId)?.version?._id,
      } : {}),
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const canSubmit =
    !!task.trim() &&
    !submitMutation.isPending &&
    !(selectedAgent && selectedAgent.supportedModels.length > 0 && !model) &&
    !(maxIterations !== 1 && pickedCriteria.length === 0);

  useCommandEnter(doSubmit, canSubmit);

  // ─── Render helpers ─────────────────────────────────────────────────────
  const summaryChips: string[] = [
    `${maxIterations} iteration${maxIterations === 1 ? "" : "s"}`,
    `${pickedCriteria.length} criteri${pickedCriteria.length === 1 ? "on" : "a"}`,
    occurrences > 1 ? `×${occurrences} runs` : "",
    worker,
    model || "",
    selectedAgentVersion ? `v${selectedAgentVersion}` : "",
    selectedMcpServers.length > 0 ? `${selectedMcpServers.length} MCP` : "",
    selectedSkills.length > 0 ? `${selectedSkills.length} skill${selectedSkills.length === 1 ? "" : "s"}` : "",
    selectedExtensions.length > 0 ? `${selectedExtensions.length} ext` : "",
  ].filter(Boolean);

  return (
    <form onSubmit={handleSubmit} className="space-y-6 pb-28">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => navigate("/runs")}
          aria-label="Back to runs"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">New Run</h1>
          <p className="text-muted-foreground">Submit a benchmark run to a coding agent worker</p>
        </div>
      </div>

      {/* Quick Start gallery (collapsible, default closed) */}
      {(topProfiles.length > 0 || recentRuns.length > 0) && (
        <CollapsibleCard
          icon={Sparkles}
          title="Quick start"
          summary="Start from a profile or re-run a recent submission"
          open={galleryOpen}
          onOpenChange={setGalleryOpen}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <GalleryCard
              icon={FilePlus2}
              title="Blank run"
              description="Configure from scratch"
              onClick={() => setGalleryOpen(false)}
            />
            {topProfiles.map((p) => (
              <GalleryCard
                key={p._id}
                icon={SlidersHorizontal}
                title={p.name}
                description={`Profile · v${p.latestVersion} · ${p.version?.workerType ?? "—"}`}
                onClick={() => applyProfile(p._id)}
              />
            ))}
            {recentRuns.map((r) => (
              <GalleryCard
                key={r._id}
                icon={History}
                title={truncate(r.scenario?.task ?? "Untitled run", 60)}
                description={`Recent · ${r.workerType}${r.model ? ` · ${r.model}` : ""}`}
                onClick={() => applyRecentRun(r)}
              />
            ))}
          </div>
          {profileList.length > 3 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {profileList.length - 3} more profile{profileList.length - 3 === 1 ? "" : "s"} available — use the Profile field below.
            </p>
          )}
        </CollapsibleCard>
      )}

      {/* ─── Scenario ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Scenario</CardTitle>
          <CardDescription>Define the task and evaluation criteria</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="task">Task *</Label>
            <TaskPromptPicker onSelect={(text) => setTask(text)} />
            <Textarea
              id="task"
              placeholder="e.g., Create a Hello World Express API"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={3}
              required
            />
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5 shrink-0" />
                New task prompts are automatically added to the task prompt library.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => setShowGenerate(!showGenerate)}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {task.trim() ? "Generate Variation" : "Generate with AI"}
              </Button>
            </div>

            {showGenerate && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <Label className="text-xs">
                  {task.trim()
                    ? "How should the variation differ? (optional)"
                    : "Describe what you want, or leave empty for a surprise (optional)"}
                </Label>
                <div className="flex gap-2">
                  <Input
                    placeholder={task.trim()
                      ? "e.g., use Python instead, add database support…"
                      : "e.g., A REST API with database and tests"}
                    value={generateDescription}
                    onChange={(e) => setGenerateDescription(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleGenerate();
                      }
                    }}
                    disabled={generateMutation.isPending}
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleGenerate}
                    disabled={generateMutation.isPending}
                  >
                    {generateMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                {generateMutation.isError && (
                  <p className="text-xs text-destructive">
                    {generateMutation.error instanceof Error
                      ? generateMutation.error.message
                      : "Generation failed"}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="criteria">
                Criteria {maxIterations !== 1 && "* "}
                <span className="text-muted-foreground font-normal">(select from registry)</span>
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 h-7 text-xs"
                onClick={() => setCreateCriterionOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                New…
              </Button>
            </div>
            <CriteriaPicker selected={pickedCriteria} onChange={setPickedCriteria} inputId="criteria" />
            <CreateCriterionDialog
              open={createCriterionOpen}
              onOpenChange={setCreateCriterionOpen}
              onCreated={(id) => setPickedCriteria((prev) => [...prev, id])}
            />
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0" />
              Required when max iterations &gt; 1. Optional for single-iteration runs (no judge evaluation).
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="maxIterations">Max iterations</Label>
              <Input
                id="maxIterations"
                type="number"
                min={1}
                max={50}
                value={maxIterations}
                onChange={(e) => setMaxIterations(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="priority">Priority</Label>
              <Input
                id="priority"
                type="number"
                min={-100}
                max={100}
                value={priority}
                onChange={(e) => setPriority(Math.max(-100, Math.min(100, parseInt(e.target.value) || 0)))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="occurrences">Occurrences</Label>
              <Input
                id="occurrences"
                type="number"
                min={1}
                max={10}
                value={occurrences}
                onChange={(e) => setOccurrences(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── Agent ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle>Agent</CardTitle>
            <CardDescription>Coding agent, model and version</CardDescription>
          </div>
          {profileList.length > 0 && (
            <div className="flex items-center gap-2">
              {selectedProfileId ? (
                <>
                  <Badge variant="secondary" className="text-xs">
                    {profileList.find((p) => p._id === selectedProfileId)?.name ?? selectedProfileId}
                    {selectedProfileVersion ? ` v${selectedProfileVersion}` : ""}
                  </Badge>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={clearProfile} aria-label="Clear profile">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : (
                <Select onValueChange={applyProfile}>
                  <SelectTrigger className="h-8 w-48 text-xs">
                    <SelectValue placeholder="Apply profile…" />
                  </SelectTrigger>
                  <SelectContent>
                    {profileList.map((p) => (
                      <SelectItem key={p._id} value={p._id}>
                        {p.name} <span className="text-muted-foreground ml-1">v{p.latestVersion}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="worker">Worker *</Label>
              <Select value={worker} onValueChange={setWorker} disabled={profileLocked}>
                <SelectTrigger id="worker">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableAgents.length > 0
                    ? availableAgents.map((a: CodingAgent) => (
                        <SelectItem key={a._id} value={a._id}>
                          {a.name}
                        </SelectItem>
                      ))
                    : WORKER_TYPES.map((w) => (
                        <SelectItem key={w} value={w}>
                          {w}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
            </div>
            {selectedAgent && selectedAgent.supportedModels.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="model">Model *</Label>
                <Select value={model} onValueChange={setModel} disabled={profileLocked}>
                  <SelectTrigger id="model">
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedAgent.supportedModels.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}{m === selectedAgent.defaultModel ? " (default)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {sortedVersions.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="agentVersion">Agent version *</Label>
                <Select value={selectedAgentVersion} onValueChange={setSelectedAgentVersion} disabled={profileLocked}>
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
          </div>
          {selectedProfileId && profileVersions.length > 1 && selectedProfileVersion && (
            <div className="space-y-1">
              <Label className="text-xs">Profile version</Label>
              <Select
                value={String(selectedProfileVersion)}
                onValueChange={(v) => changeProfileVersion(Number(v))}
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {profileVersions
                    .slice()
                    .sort((a: ProfileVersionDocument, b: ProfileVersionDocument) => b.version - a.version)
                    .map((v: ProfileVersionDocument) => (
                      <SelectItem key={v.version} value={String(v.version)}>
                        v{v.version}
                        {v.version === profileList.find((p) => p._id === selectedProfileId)?.latestVersion
                          ? " (latest)"
                          : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── MCP Servers (collapsible) ─────────────────────────────────── */}
      {activeMcpServers.length > 0 && (
        <CollapsibleCard
          icon={Server}
          title="MCP Servers"
          summary={
            selectedMcpServers.length === 0
              ? "None selected"
              : `${selectedMcpServers.length} server${selectedMcpServers.length === 1 ? "" : "s"} selected`
          }
          open={mcpOpen}
          onOpenChange={setMcpOpen}
          disabled={profileLocked}
        >
          <div className="space-y-2">
            {activeMcpServers.map((s: McpServerDocument) => (
              <label
                key={s._id}
                className={`flex items-center gap-3 rounded-md border p-3 transition-colors ${profileLocked ? "opacity-60" : "cursor-pointer hover:bg-accent/50"}`}
              >
                <Checkbox
                  checked={selectedMcpServers.includes(s._id)}
                  disabled={profileLocked}
                  onCheckedChange={(checked) => {
                    setSelectedMcpServers((prev) =>
                      checked ? [...prev, s._id] : prev.filter((id) => id !== s._id)
                    );
                  }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{s._id}</span>
                    <Badge variant="outline" className="text-xs uppercase">{s.type}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {s.name}{s.description ? ` — ${s.description}` : ""}
                  </p>
                </div>
              </label>
            ))}
          </div>
        </CollapsibleCard>
      )}

      {/* ─── Skills (collapsible) ──────────────────────────────────────── */}
      <CollapsibleCard
        icon={BookOpen}
        title="Skills"
        summary={
          selectedSkills.length === 0
            ? "None selected"
            : `${selectedSkills.length} skill${selectedSkills.length === 1 ? "" : "s"} selected`
        }
        open={skillsOpen}
        onOpenChange={setSkillsOpen}
        disabled={profileLocked}
      >
        <SkillPicker selected={selectedSkills} onChange={setSelectedSkills} disabled={profileLocked} />
      </CollapsibleCard>

      {/* ─── Extensions (collapsible, VS Code only) ────────────────────── */}
      {isVscodeWorker && (
        <CollapsibleCard
          icon={Puzzle}
          title="Extensions"
          summary={
            selectedExtensions.length === 0
              ? "None selected"
              : `${selectedExtensions.length} extension${selectedExtensions.length === 1 ? "" : "s"} selected`
          }
          open={extensionsOpen}
          onOpenChange={setExtensionsOpen}
          disabled={profileLocked}
        >
          <ExtensionPicker selected={selectedExtensions} onChange={setSelectedExtensions} disabled={profileLocked} />
        </CollapsibleCard>
      )}

      {/* ─── Sticky action bar ─────────────────────────────────────────── */}
      <div className="sticky bottom-0 -mx-6 lg:-mx-8 -mb-6 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 px-6 lg:px-8 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {summaryChips.map((chip, i) => (
              <span key={i} className="flex items-center gap-2">
                {i > 0 && <span className="text-muted-foreground/40">·</span>}
                <span>{chip}</span>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {submitMutation.isError && (
              <p className="text-xs text-destructive">
                {submitMutation.error instanceof Error ? submitMutation.error.message : "Submission failed"}
              </p>
            )}
            {!profileLocked && worker && model && (
              <Dialog open={saveProfileOpen} onOpenChange={setSaveProfileOpen}>
                <DialogTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="gap-1.5">
                    <Save className="h-4 w-4" /> Save as Profile
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Save as Profile</DialogTitle>
                    <DialogDescription>
                      Save the current agent configuration as a reusable profile.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2 py-2">
                    <Label htmlFor="profileName">Profile Name *</Label>
                    <Input
                      id="profileName"
                      value={saveProfileName}
                      onChange={(e) => setSaveProfileName(e.target.value)}
                      placeholder="e.g. My Benchmark Profile"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && saveProfileName.trim()) {
                          e.preventDefault();
                          saveProfileMutation.mutate();
                        }
                      }}
                    />
                  </div>
                  <DialogFooter>
                    <Button
                      onClick={() => saveProfileMutation.mutate()}
                      disabled={!saveProfileName.trim() || saveProfileMutation.isPending}
                    >
                      {saveProfileMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="mr-2 h-4 w-4" />
                      )}
                      Save
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
            <Button type="submit" disabled={!canSubmit} className="gap-1.5">
              {submitMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Submit {occurrences > 1 ? `${occurrences} Runs` : "Run"}
              <KbdBadge />
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
