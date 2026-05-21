// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Fragment, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Send, Loader2, ArrowLeft, ArrowRight, Server, Info, BookOpen, Sparkles, Puzzle, SlidersHorizontal, X, Save, Plus } from "lucide-react";
import { WORKER_TYPES, type CodingAgent, type McpServerDocument, type ProfileWithVersion, type ProfileVersionDocument } from "@/types";
import { Checkbox } from "@/components/ui/checkbox";
import { CriteriaPicker } from "@/components/CriteriaPicker";
import { CreateCriterionDialog } from "@/components/CreateCriterionDialog";
import { SkillPicker, parseSkillSpec } from "@/components/SkillPicker";
import { ExtensionPicker } from "@/components/ExtensionPicker";
import { Stepper } from "@/components/Stepper";
import { TaskPromptPicker } from "@/components/TaskPromptPicker";
import { TaskPromptFeatures } from "@/components/TaskPromptFeatures";
import { useCommandEnter } from "@/hooks/useCommandEnter";
import { KbdBadge } from "@/components/KbdBadge";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

const STEPS = ["Configure", "Review & Submit"];

type VariationDraft = {
  profileId: string;
  profileVersion?: number;
};

export function SubmitRun() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);

  // Form state
  const [task, setTask] = useState("");
  const [pickedCriteria, setPickedCriteria] = useState<string[]>([]);
  const [worker, setWorker] = useState<string>("coder-acp-copilot");
  const [model, setModel] = useState<string>("");
  const [maxIterations, setMaxIterations] = useState<number>(10);
  const [occurrences, setOccurrences] = useState<number>(5);
  const [priority, setPriority] = useState<number>(0);

  // Inline criteria creation dialog
  const [createCriterionOpen, setCreateCriterionOpen] = useState(false);

  // MCP servers
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);

  // Skills
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);

  // Extensions
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>([]);

  // Profile
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedProfileVersion, setSelectedProfileVersion] = useState<number | null>(null);
  const [variationDrafts, setVariationDrafts] = useState<VariationDraft[]>([]);
  const [variationProfileVersions, setVariationProfileVersions] = useState<Record<string, ProfileVersionDocument[]>>({});
  const profileLocked = !!selectedProfileId;

  // Agent version
  const [selectedAgentVersion, setSelectedAgentVersion] = useState<string>("");

  // Fetch agents from the API
  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.listAgents(),
  });

  // Fetch MCP servers
  const { data: mcpServers = [] } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.listMcpServers(),
  });

  // Fetch profiles
  const { data: profiles = [] } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });

  // Fetch versions for the selected profile
  const { data: profileVersions = [] } = useQuery({
    queryKey: ["profile-versions", selectedProfileId],
    queryFn: () => api.listProfileVersions(selectedProfileId!),
    enabled: !!selectedProfileId,
  });

  const applyVersionConfig = (v: ProfileVersionDocument) => {
    setWorker(v.workerType);
    setModel(v.model);
    setSelectedAgentVersion(v.agentVersion ?? "");
    setSelectedMcpServers(v.mcpServers ?? []);
    setSelectedSkills(v.skillRevisions ?? []);
    setSelectedExtensions(v.extensions ?? []);
  };

  // When profile is selected, apply its latest version configuration
  const applyProfile = (profileId: string | null) => {
    setSelectedProfileId(profileId);
    setVariationDrafts((prev) => prev.filter((v) => v.profileId !== profileId));
    if (!profileId) return;
    const p = (profiles as ProfileWithVersion[]).find((p) => p._id === profileId);
    if (!p?.version) return;
    setSelectedProfileVersion(p.version.version);
    applyVersionConfig(p.version);
  };

  // When profile version changes, fetch and apply that version
  const changeProfileVersion = (version: number) => {
    setSelectedProfileVersion(version);
    const v = profileVersions.find((pv: ProfileVersionDocument) => pv.version === version);
    if (v) applyVersionConfig(v);
  };

  const clearProfile = () => {
    setSelectedProfileId(null);
    setSelectedProfileVersion(null);
    setVariationDrafts([]);
  };

  const addVariationDraft = () => {
    setVariationDrafts((prev) => {
      const used = new Set(prev.map((v) => v.profileId).filter(Boolean));
      const nextProfile = (profiles as ProfileWithVersion[]).find(
        (p) => p._id !== selectedProfileId && !used.has(p._id),
      );
      if (!nextProfile) {
        toast.info("All available profiles are already used in variations.");
        return prev;
      }
      return [...prev, { profileId: nextProfile._id, profileVersion: nextProfile.latestVersion }];
    });
  };

  const updateVariationDraft = (index: number, patch: Partial<VariationDraft>) => {
    setVariationDrafts((prev) => prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  };

  const removeVariationDraft = (index: number) => {
    setVariationDrafts((prev) => prev.filter((_, i) => i !== index));
  };

  const getUsedVariationProfileIds = (excludeIndex?: number): Set<string> => {
    const used = new Set<string>();
    variationDrafts.forEach((draft, idx) => {
      if (excludeIndex !== undefined && idx === excludeIndex) return;
      if (draft.profileId.trim()) used.add(draft.profileId);
    });
    return used;
  };

  const getAvailableVariationProfiles = (excludeIndex?: number) => {
    const used = getUsedVariationProfileIds(excludeIndex);
    return (profiles as ProfileWithVersion[]).filter((p) => p._id !== selectedProfileId && !used.has(p._id));
  };

  useEffect(() => {
    const profileIds = Array.from(new Set(variationDrafts.map((v) => v.profileId).filter(Boolean)));
    profileIds.forEach((profileId) => {
      if (variationProfileVersions[profileId] !== undefined) return;
      api.listProfileVersions(profileId)
        .then((versions) => {
          setVariationProfileVersions((prev) => ({
            ...prev,
            [profileId]: versions,
          }));
        })
        .catch(() => {
          setVariationProfileVersions((prev) => ({
            ...prev,
            [profileId]: [],
          }));
        });
    });
  }, [variationDrafts, variationProfileVersions]);

  // Save as Profile
  const [saveProfileName, setSaveProfileName] = useState("");
  const [saveProfileOpen, setSaveProfileOpen] = useState(false);

  const suggestedProfileName = () => {
    const workerName = selectedAgent?.name ?? worker;
    const modelName = model || selectedAgent?.defaultModel || "default-model";
    const versionSuffix = selectedAgentVersion ? `-${selectedAgentVersion}` : "";
    return `${workerName}-${modelName}${versionSuffix}`;
  };

  const handleSaveProfileOpenChange = (open: boolean) => {
    setSaveProfileOpen(open);
    if (open) {
      setSaveProfileName(suggestedProfileName());
    }
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

  const activeMcpServers = mcpServers.filter((s: McpServerDocument) => !s.deletedAt);

  const activeAgents = agents.filter((a: CodingAgent) => !a.deletedAt);
  // available defaults to true when undefined (backward compat with agents registered before this field existed)
  const availableAgents = activeAgents.filter((a: CodingAgent) => a.available !== false);
  const selectedAgent = activeAgents.find((a: CodingAgent) => a._id === worker);
  const isVscodeWorker = worker.includes("vscode");

  // When agent changes, reset model to the agent's default and clear extensions for non-vscode workers
  useEffect(() => {
    if (selectedProfileId) return; // profile controls these values
    if (selectedAgent) {
      setModel(selectedAgent.defaultModel ?? "");
    } else {
      setModel("");
    }
    if (!worker.includes("vscode")) {
      setSelectedExtensions([]);
    }
  }, [worker, selectedAgent?.defaultModel]);

  // Fetch active versions for selected agent
  const { data: agentVersions = [] } = useQuery({
    queryKey: ["agent-versions", worker],
    queryFn: () => api.listAgentVersions(worker, "active"),
    enabled: !!worker,
  });

  // Sort versions by createdAt descending (latest first)
  const sortedVersions = [...agentVersions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // When agent changes or versions load, auto-select latest version
  useEffect(() => {
    if (selectedProfileId) return; // profile controls agent version
    if (sortedVersions.length > 0) {
      setSelectedAgentVersion(sortedVersions[0].agentVersion);
    } else {
      setSelectedAgentVersion("");
    }
  }, [worker, agentVersions.length]);

  // AI generation state
  const [showGenerate, setShowGenerate] = useState(false);
  const [generateDescription, setGenerateDescription] = useState("");

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
      // Variation mode: use existing task, optional guidance from description
      generateMutation.mutate({
        existingPrompt: task.trim(),
        ...(generateDescription.trim() && { description: generateDescription.trim() }),
      });
    } else {
      // From-scratch mode: generate from description (or surprise me if empty)
      generateMutation.mutate({
        ...(generateDescription.trim() && { description: generateDescription.trim() }),
      });
    }
  };

  // Task prompt entity state (created on "Continue" to step 2)
  const [taskPromptId, setTaskPromptId] = useState<string | null>(null);

  const createTaskPromptMutation = useMutation({
    mutationFn: async () => {
      const taskPrompt = await api.createTaskPrompt(task.trim());
      return taskPrompt;
    },
    onSuccess: (data) => setTaskPromptId(data._id),
  });

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

  const handleContinue = () => {
    if (!task.trim()) return;
    setStep(2);
    createTaskPromptMutation.mutate();
  };

  const doSubmit = () => {
    if (!task.trim()) return;

    const criteria = pickedCriteria;

    const normalizedVariationDrafts = variationDrafts.filter((v) => v.profileId.trim().length > 0);

    const profileVariations = normalizedVariationDrafts.map((v) => {
      const profile = (profiles as ProfileWithVersion[]).find((p) => p._id === v.profileId);
      const resolvedProfileVersion = v.profileVersion ?? profile?.latestVersion;
      return {
        profileId: v.profileId,
        ...(resolvedProfileVersion ? { profileVersion: resolvedProfileVersion } : {}),
      };
    });

    const inVariationMode = selectedProfileId && profileVariations.length > 0;

    submitMutation.mutate({
      scenario: {
        task: task.trim(),
        criteria,
      },
      ...(inVariationMode ? {} : { ...(worker ? { worker } : {}) }),
      ...(inVariationMode ? {} : { ...(model ? { model } : {}) }),
      maxIterations,
      ...(priority !== 0 ? { priority } : {}),
      ...(occurrences > 1 ? { count: occurrences } : {}),
      ...(inVariationMode ? {} : { ...(selectedMcpServers.length > 0 ? { mcpServers: selectedMcpServers } : {}) }),
      ...(inVariationMode ? {} : { ...(selectedSkills.length > 0 ? { skills: selectedSkills } : {}) }),
      ...(inVariationMode ? {} : { ...(selectedExtensions.length > 0 ? { extensions: selectedExtensions } : {}) }),
      ...(inVariationMode ? {} : { ...(selectedAgentVersion ? { agentVersion: selectedAgentVersion } : {}) }),
      ...(inVariationMode
        ? {
            baseProfileId: selectedProfileId,
            ...(selectedProfileVersion ? { baseProfileVersion: selectedProfileVersion } : {}),
            profileVariations,
          }
        : {}),
      ...(selectedProfileId && profileVariations.length === 0
        ? {
            profileId: selectedProfileId,
            ...(selectedProfileVersion ? { profileVersion: selectedProfileVersion } : {}),
          }
        : {}),
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  // Cmd+Enter / Ctrl+Enter shortcut for primary action
  useCommandEnter(
    step === 1 ? handleContinue : doSubmit,
    step === 1 ? !!task.trim() : !!task.trim() && !submitMutation.isPending,
  );

  const summaryBaseProfile = selectedProfileId
    ? (profiles as ProfileWithVersion[]).find((p) => p._id === selectedProfileId)
    : null;
  const summaryVariations = variationDrafts
    .filter((v) => v.profileId.trim().length > 0)
    .map((v) => {
      const profile = (profiles as ProfileWithVersion[]).find((p) => p._id === v.profileId);

      return {
        ...v,
        profileName: profile?.name ?? v.profileId,
        profileVersion: v.profileVersion ?? profile?.latestVersion,
      };
    });

  return (
    <TooltipProvider>
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">New Run</h1>
          <p className="text-muted-foreground">Submit a benchmark run to a coding agent worker</p>
        </div>

      <Stepper steps={STEPS} currentStep={step} />

      {/* ─── STEP 1: Configure ──────────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-6">
          {/* Scenario */}
          <Card>
            <CardHeader>
              <CardTitle>Scenario</CardTitle>
              <CardDescription>Define the task and evaluation criteria</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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
                        placeholder={
                          task.trim()
                            ? "e.g., use Python instead, add database support…"
                            : "e.g., A REST API with database and tests"
                        }
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

              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="maxIterations">
                    <span className="text-muted-foreground">Max iterations</span>
                  </Label>
                  <Input
                    id="maxIterations"
                    type="number"
                    min={1}
                    max={50}
                    value={maxIterations}
                    onChange={(e) => setMaxIterations(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                  />
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Info className="h-3.5 w-3.5 shrink-0" />
                    Maximum number of back and forth turns between the coding agent and simulated user.
                  </p>
                </div>
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

              <div className="space-y-2">
                <Label htmlFor="priority">Priority</Label>
                <Input
                  id="priority"
                  type="number"
                  min={-100}
                  max={100}
                  value={priority}
                  onChange={(e) => setPriority(Math.max(-100, Math.min(100, parseInt(e.target.value) || 0)))}
                  className="w-24"
                />
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Info className="h-3.5 w-3.5 shrink-0" />
                  Higher priority runs are dispatched first. Default is 0.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="occurrences">Number of occurrences</Label>
                <Input
                  id="occurrences"
                  type="number"
                  min={1}
                  max={10}
                  value={occurrences}
                  onChange={(e) => setOccurrences(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                  className="w-24"
                />
                <p className="text-xs text-muted-foreground">
                  Submit {occurrences} identical run{occurrences !== 1 ? "s" : ""}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Profile Selector */}
          {(profiles as ProfileWithVersion[]).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <SlidersHorizontal className="h-5 w-5" />
                  Profile <span className="text-muted-foreground font-normal text-sm">(optional)</span>
                </CardTitle>
                <CardDescription>Select a profile to pre-fill agent configuration</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {selectedProfileId ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,2fr)_auto] items-end gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Base Profile</Label>
                        <Select value={selectedProfileId} onValueChange={applyProfile}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select profile" />
                          </SelectTrigger>
                          <SelectContent>
                            {(profiles as ProfileWithVersion[]).map((p) => (
                              <SelectItem key={p._id} value={p._id}>
                                {p.name} <span className="text-muted-foreground ml-1">v{p.latestVersion}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Version</Label>
                        <Select
                          value={String(
                            selectedProfileVersion ??
                              (profiles as ProfileWithVersion[]).find((p) => p._id === selectedProfileId)?.latestVersion ??
                              "",
                          )}
                          onValueChange={(v) => changeProfileVersion(Number(v))}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder="Select version" />
                          </SelectTrigger>
                          <SelectContent>
                            {(profileVersions.length > 0
                              ? profileVersions.slice().sort((a: ProfileVersionDocument, b: ProfileVersionDocument) => b.version - a.version)
                              : [{
                                  version:
                                    selectedProfileVersion ??
                                    (profiles as ProfileWithVersion[]).find((p) => p._id === selectedProfileId)?.latestVersion ??
                                    0,
                                }]
                            ).map((v) => (
                              <SelectItem key={v.version} value={String(v.version)}>
                                v{v.version}
                                {v.version === (profiles as ProfileWithVersion[]).find((p) => p._id === selectedProfileId)?.latestVersion
                                  ? " (latest)"
                                  : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button type="button" variant="ghost" size="icon" className="h-9 w-9" onClick={clearProfile}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <span className="text-xs text-muted-foreground">Agent config locked by profile</span>

                    <Separator />

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-sm">Variations</Label>
                          <p className="text-xs text-muted-foreground">
                            Add additional profiles to run as variations under this base profile.
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={addVariationDraft}
                          disabled={getAvailableVariationProfiles().length === 0}
                          className="gap-1.5"
                        >
                          <Plus className="h-4 w-4" /> Add Variation
                        </Button>
                      </div>

                      {getAvailableVariationProfiles().length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          All available profiles are already used in variations.
                        </p>
                      )}

                      {variationDrafts.length === 0 && (
                        <p className="text-sm text-muted-foreground">No variations yet. Submitting now runs only the base profile.</p>
                      )}

                      {variationDrafts.map((draft, index) => (
                        <div key={index} className="rounded-md border">
                          {(() => {
                            const selectedVariationProfile = (profiles as ProfileWithVersion[]).find((p) => p._id === draft.profileId);
                            const availableProfiles = getAvailableVariationProfiles(index);
                            const hasAvailableProfiles = availableProfiles.length > 0;
                            const variationVersionOptions = (() => {
                              if (!draft.profileId) return [] as number[];
                              const fetched = variationProfileVersions[draft.profileId] ?? [];
                              if (fetched.length > 0) {
                                return fetched.map((v) => v.version).sort((a, b) => b - a);
                              }
                              return selectedVariationProfile?.latestVersion ? [selectedVariationProfile.latestVersion] : [];
                            })();

                            return (
                              <div className="p-3">
                                <div className="flex items-end gap-2">
                                  <div className="flex-1 space-y-1">
                                    <Label className="text-xs">Variation #{index + 1} Profile</Label>
                                    <Select
                                      value={draft.profileId || undefined}
                                      onValueChange={(value) => {
                                        const selectedProfile = (profiles as ProfileWithVersion[]).find((p) => p._id === value);
                                        updateVariationDraft(index, {
                                          profileId: value,
                                          profileVersion: selectedProfile?.latestVersion,
                                        });
                                      }}
                                    >
                                      <SelectTrigger>
                                        <SelectValue placeholder="Select profile" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {availableProfiles.map((p) => (
                                          <SelectItem key={p._id} value={p._id}>
                                            {p.name}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    {!draft.profileId && hasAvailableProfiles && (
                                      <p className="text-xs text-muted-foreground">Select a profile for this variation.</p>
                                    )}
                                    {!hasAvailableProfiles && !draft.profileId && (
                                      <p className="text-xs text-muted-foreground">No profile available for this variation.</p>
                                    )}
                                  </div>
                                  <div className="w-40 space-y-1">
                                    <Label className="text-xs">Version</Label>
                                    <Select
                                      value={String(draft.profileVersion ?? variationVersionOptions[0] ?? "")}
                                      onValueChange={(value) => updateVariationDraft(index, { profileVersion: Number(value) })}
                                      disabled={!draft.profileId}
                                    >
                                      <SelectTrigger className="w-full">
                                        <SelectValue placeholder={draft.profileId ? "Select version" : "Select profile first"} />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {variationVersionOptions.map((version) => (
                                          <SelectItem key={version} value={String(version)}>
                                            v{version}
                                            {version === selectedVariationProfile?.latestVersion ? " (latest)" : ""}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-9 w-9"
                                    onClick={() => removeVariationDraft(index)}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <Select onValueChange={applyProfile}>
                    <SelectTrigger>
                      <SelectValue placeholder="No profile — configure manually" />
                    </SelectTrigger>
                    <SelectContent>
                      {(profiles as ProfileWithVersion[]).map((p) => (
                        <SelectItem key={p._id} value={p._id}>
                          {p.name} <span className="text-muted-foreground ml-1">v{p.latestVersion}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </CardContent>
            </Card>
          )}

          {/* Worker */}
          <Card>
            <CardHeader>
              <CardTitle>Worker</CardTitle>
              <CardDescription>Select which coding agent to run</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="worker">Worker Type *</Label>
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
                        ))
                    }
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
                  <Label htmlFor="agentVersion">Agent Version *</Label>
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
            </CardContent>
          </Card>

          {/* MCP Servers (optional) */}
          {activeMcpServers.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Server className="h-5 w-5" />
                  MCP Servers <span className="text-muted-foreground font-normal text-sm">(optional)</span>
                </CardTitle>
                <CardDescription>Select remote MCP servers to make available to the coding agent</CardDescription>
              </CardHeader>
              <CardContent>
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
                          setSelectedMcpServers(prev =>
                            checked
                              ? [...prev, s._id]
                              : prev.filter(id => id !== s._id)
                          );
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm">{s._id}</span>
                          <Badge variant="outline" className="text-xs uppercase">{s.type}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{s.name}{s.description ? ` — ${s.description}` : ""}</p>
                      </div>
                    </label>
                  ))}
                </div>
                {selectedMcpServers.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    {selectedMcpServers.length} server{selectedMcpServers.length !== 1 ? "s" : ""} selected
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Skills (optional) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-5 w-5" />
                Skills <span className="text-muted-foreground font-normal text-sm">(optional)</span>
              </CardTitle>
              <CardDescription>Search and select agent skills to inject into the coding agent prompt</CardDescription>
            </CardHeader>
            <CardContent>
              <SkillPicker selected={selectedSkills} onChange={setSelectedSkills} disabled={profileLocked} />
            </CardContent>
          </Card>

          {/* Extensions (optional — only for VS Code workers) */}
          {isVscodeWorker && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Puzzle className="h-5 w-5" />
                  Extensions <span className="text-muted-foreground font-normal text-sm">(optional)</span>
                </CardTitle>
                <CardDescription>Search and select VS Code extensions to install for this run</CardDescription>
              </CardHeader>
              <CardContent>
                <ExtensionPicker selected={selectedExtensions} onChange={setSelectedExtensions} disabled={profileLocked} />
              </CardContent>
            </Card>
          )}

          <Separator />

          {/* Continue */}
          <div className="flex justify-between">
            {!profileLocked && worker && model ? (
              <Dialog open={saveProfileOpen} onOpenChange={handleSaveProfileOpenChange}>
                <DialogTrigger asChild>
                  <Button type="button" variant="outline" className="gap-1.5">
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
            ) : (
              <div />
            )}
            <Button type="button" onClick={handleContinue} disabled={!task.trim() || (selectedAgent && selectedAgent.supportedModels.length > 0 && !model) || (maxIterations !== 1 && pickedCriteria.length === 0)} className="gap-1.5">
              Continue <ArrowRight className="h-4 w-4" /> <KbdBadge />
            </Button>
          </div>
        </div>
      )}

      {/* ─── STEP 2: Review & Submit ────────────────────────────────────── */}
      {step === 2 && (
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Summary */}
          <Card>
            <CardHeader>
              <CardTitle>Run Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-[8rem_1fr] gap-y-2">
                {selectedProfileId && summaryVariations.length === 0 && (
                  <>
                    <span className="text-muted-foreground">Profile</span>
                    <div className="flex items-center gap-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="font-medium truncate max-w-xs cursor-help">{summaryBaseProfile?.name ?? selectedProfileId}</span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{summaryBaseProfile?.name ?? selectedProfileId}</p>
                      </TooltipContent>
                    </Tooltip>
                    {selectedProfileVersion && (
                      <span className="text-muted-foreground">v{selectedProfileVersion}</span>
                    )}
                    </div>
                  </>
                )}
                <span className="text-muted-foreground">Task</span>
                <span className="whitespace-pre-wrap">{task.trim()}</span>
                <span className="text-muted-foreground">Worker</span>
                <span className="font-mono">{worker}</span>
                {selectedAgentVersion && (
                  <>
                    <span className="text-muted-foreground">Agent Version</span>
                    <span className="font-mono">{selectedAgentVersion}</span>
                  </>
                )}
                <span className="text-muted-foreground">Max iterations</span>
                <span>{maxIterations}</span>
                <span className="text-muted-foreground">Priority</span>
                <span>{priority}</span>
                <span className="text-muted-foreground">Occurrences</span>
                <span>{occurrences}</span>
                {pickedCriteria.length > 0 && (
                  <>
                    <span className="text-muted-foreground">Criteria</span>
                    <div className="flex flex-wrap gap-1">
                      {pickedCriteria.map((c) => (
                        <Badge key={c} variant="secondary" className="font-mono text-xs">
                          {c}
                        </Badge>
                      ))}
                    </div>
                  </>
                )}
                {selectedMcpServers.length > 0 && (
                  <>
                    <span className="text-muted-foreground">MCP Servers</span>
                    <div className="flex flex-wrap gap-1">
                      {selectedMcpServers.map((s) => (
                        <Badge key={s} variant="secondary" className="font-mono text-xs">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </>
                )}
                {selectedSkills.length > 0 && (
                  <>
                    <span className="text-muted-foreground">Skills</span>
                    <div className="flex flex-wrap gap-1">
                      {selectedSkills.map((s) => {
                        const { slug, commitHash } = parseSkillSpec(s);
                        return (
                          <Badge key={s} variant="secondary" className="font-mono text-xs gap-1">
                            {slug}
                            {commitHash && (
                              <span className="text-muted-foreground">@{commitHash.substring(0, 7)}</span>
                            )}
                          </Badge>
                        );
                      })}
                    </div>
                  </>
                )}
                {selectedExtensions.length > 0 && (
                  <>
                    <span className="text-muted-foreground">Extensions</span>
                    <div className="flex flex-wrap gap-1">
                      {selectedExtensions.map((e) => (
                        <Badge key={e} variant="secondary" className="font-mono text-xs">
                          {e}
                        </Badge>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          {selectedProfileId && summaryVariations.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Profile Variations</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
                  <span className="text-muted-foreground">Base profile</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="font-medium truncate max-w-xs cursor-help">{summaryBaseProfile?.name ?? selectedProfileId}</span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{summaryBaseProfile?.name ?? selectedProfileId}</p>
                      </TooltipContent>
                    </Tooltip>
                    {selectedProfileVersion && (
                      <span className="text-muted-foreground">v{selectedProfileVersion}</span>
                    )}
                  </div>

                  {summaryVariations.map((variation, index) => (
                    <Fragment key={`${variation.profileId}-${index}`}>
                      <span className="text-muted-foreground">Variation {index + 1}</span>
                      <div className="flex flex-wrap items-center gap-2">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="font-medium truncate max-w-xs cursor-help">{variation.profileName}</span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{variation.profileName}</p>
                          </TooltipContent>
                        </Tooltip>
                        {variation.profileVersion && <span className="text-muted-foreground">v{variation.profileVersion}</span>}
                      </div>
                    </Fragment>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Prompt Features */}
          {createTaskPromptMutation.isPending && (
            <Card>
              <CardContent className="py-6">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Registering task prompt…</span>
                </div>
              </CardContent>
            </Card>
          )}

          {createTaskPromptMutation.isError && (
            <Card>
              <CardContent className="py-6">
                <p className="text-sm text-destructive">
                  {createTaskPromptMutation.error instanceof Error
                    ? createTaskPromptMutation.error.message
                    : "Failed to register task prompt"}
                </p>
              </CardContent>
            </Card>
          )}

          {taskPromptId && (
            <Card>
              <CardHeader>
                <CardTitle>Prompt Features</CardTitle>
              </CardHeader>
              <CardContent>
                <TaskPromptFeatures taskPromptId={taskPromptId} autoExtract />
              </CardContent>
            </Card>
          )}

          <Separator />

          {/* Back / Submit */}
          <div className="flex items-center justify-between">
            <Button type="button" variant="ghost" onClick={() => setStep(1)} className="gap-1.5">
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <div className="flex items-center gap-3">
              {submitMutation.isError && (
                <p className="text-sm text-destructive">
                  {submitMutation.error instanceof Error ? submitMutation.error.message : "Submission failed"}
                </p>
              )}
              <Button type="submit" disabled={!task.trim() || submitMutation.isPending} className="gap-1.5">
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
        </form>
      )}
    </div>
    </TooltipProvider>
  );
}
