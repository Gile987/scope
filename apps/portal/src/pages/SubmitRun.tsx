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
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Send, Loader2, ArrowLeft, ArrowRight, Sparkles, CheckCircle2, XCircle, MinusCircle, Plus, Check, Server } from "lucide-react";
import { WORKER_TYPES, type PromptFeatureExtraction, type SuggestedPromptFeature, type CodingAgent, type McpServerDocument } from "@/types";
import { Checkbox } from "@/components/ui/checkbox";
import { CriteriaPicker } from "@/components/CriteriaPicker";
import { Stepper } from "@/components/Stepper";
import { PromptFeatureWizard } from "@/components/PromptFeatureWizard";
import { toast } from "sonner";

const STEPS = ["Configure", "Review & Submit"];

export function SubmitRun() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);

  // Form state
  const [task, setTask] = useState("");
  const [criteriaText, setCriteriaText] = useState("");
  const [pickedCriteria, setPickedCriteria] = useState<string[]>([]);
  const [version, setVersion] = useState<"v1" | "v2">("v2");
  const [worker, setWorker] = useState<string>("coder-acp-copilot");
  const [model, setModel] = useState<string>("");
  const [maxIterations, setMaxIterations] = useState<string>("10");
  const [occurrences, setOccurrences] = useState<number>(1);

  // MCP servers
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);

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

  const activeMcpServers = mcpServers.filter((s: McpServerDocument) => !s.deletedAt);

  const activeAgents = agents.filter((a: CodingAgent) => !a.deletedAt);
  const selectedAgent = activeAgents.find((a: CodingAgent) => a._id === worker);

  // When agent changes, reset model to the agent's default
  useEffect(() => {
    if (selectedAgent) {
      setModel(selectedAgent.defaultModel ?? "");
    } else {
      setModel("");
    }
  }, [worker, selectedAgent?.defaultModel]);

  // Optional persona
  const [personality, setPersonality] = useState<string>("");
  const [experience, setExperience] = useState<string>("");
  const [verbosity, setVerbosity] = useState<string>("");
  const [userType, setUserType] = useState<string>("");

  // Extraction state
  const [extraction, setExtraction] = useState<PromptFeatureExtraction | null>(null);

  // Sheet wizard state for creating suggested features
  const [activeSuggestion, setActiveSuggestion] = useState<SuggestedPromptFeature | null>(null);
  const [createdSuggestionIds, setCreatedSuggestionIds] = useState<Set<string>>(new Set());

  const extractMutation = useMutation({
    mutationFn: (opts?: { force?: boolean }) => api.extractPromptFeatures(task.trim(), undefined, opts?.force),
    onSuccess: (data) => setExtraction(data),
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
    // Optimistically advance to step 2 and fire extraction
    setStep(2);
    extractMutation.mutate({});
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!task.trim()) return;

    const criteria =
      version === "v2"
        ? pickedCriteria
        : criteriaText
            .split("\n")
            .map((c) => c.trim())
            .filter(Boolean);

    const hasPersona = personality || experience || verbosity || userType;

    submitMutation.mutate({
      scenario: {
        task: task.trim(),
        criteria,
        version,
      },
      worker,
      ...(model ? { model } : {}),
      maxIterations: parseInt(maxIterations, 10) || undefined,
      ...(occurrences > 1 ? { count: occurrences } : {}),
      ...(hasPersona
        ? {
            persona: {
              personality: personality || "friendly",
              experience: experience || "senior",
              verbosity: verbosity || "moderate",
              type: userType || "traditional",
            },
          }
        : {}),
      ...(extraction?._id ? { promptFeatureExtractionId: extraction._id } : {}),
      ...(selectedMcpServers.length > 0 ? { mcpServers: selectedMcpServers } : {}),
    });
  };

  const detectedFeatures = extraction?.promptFeatureResults?.filter((f) => f.detected) ?? [];
  const notDetectedFeatures = extraction?.promptFeatureResults?.filter((f) => !f.detected && f.evaluated) ?? [];
  const skippedFeatures = extraction?.promptFeatureResults?.filter((f) => !f.evaluated) ?? [];
  const suggestedFeatures = extraction?.suggestedFeatures ?? [];

  return (
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
                <Textarea
                  id="task"
                  placeholder="e.g., Create a Hello World Express API"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  rows={3}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="version">Criteria Version</Label>
                  <Select value={version} onValueChange={(v) => setVersion(v as "v1" | "v2")}>
                    <SelectTrigger id="version">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="v1">v1 — free-text prompts</SelectItem>
                      <SelectItem value="v2">v2 — criteria IDs</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxIterations">Max Iterations</Label>
                  <Input
                    id="maxIterations"
                    type="number"
                    min={1}
                    max={50}
                    value={maxIterations}
                    onChange={(e) => setMaxIterations(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="criteria">
                  Criteria{" "}
                  {version === "v2" ? (
                    <span className="text-muted-foreground font-normal">(select from registry)</span>
                  ) : (
                    <span className="text-muted-foreground font-normal">(one per line)</span>
                  )}
                </Label>
                {version === "v2" ? (
                  <CriteriaPicker selected={pickedCriteria} onChange={setPickedCriteria} />
                ) : (
                  <Textarea
                    id="criteria"
                    placeholder="The code must include unit tests&#10;The API should return JSON responses"
                    value={criteriaText}
                    onChange={(e) => setCriteriaText(e.target.value)}
                    rows={4}
                    className="font-mono text-sm"
                  />
                )}
              </div>
            </CardContent>
          </Card>

          {/* Worker */}
          <Card>
            <CardHeader>
              <CardTitle>Worker</CardTitle>
              <CardDescription>Select which coding agent to run</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="worker">Worker Type *</Label>
                <Select value={worker} onValueChange={setWorker}>
                  <SelectTrigger id="worker">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {activeAgents.length > 0
                      ? activeAgents.map((a: CodingAgent) => (
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
                  <Label htmlFor="model">Model</Label>
                  <Select value={model} onValueChange={setModel}>
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
                      className="flex items-center gap-3 rounded-md border p-3 cursor-pointer hover:bg-accent/50 transition-colors"
                    >
                      <Checkbox
                        checked={selectedMcpServers.includes(s._id)}
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

          {/* Persona (optional) */}
          <Card>
            <CardHeader>
              <CardTitle>
                Persona <span className="text-muted-foreground font-normal text-sm">(optional)</span>
              </CardTitle>
              <CardDescription>Configure the judge persona for evaluation style</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Personality</Label>
                  <Select value={personality} onValueChange={setPersonality}>
                    <SelectTrigger>
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="friendly">Friendly</SelectItem>
                      <SelectItem value="demanding">Demanding</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Experience</Label>
                  <Select value={experience} onValueChange={setExperience}>
                    <SelectTrigger>
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="junior">Junior</SelectItem>
                      <SelectItem value="senior">Senior</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Verbosity</Label>
                  <Select value={verbosity} onValueChange={setVerbosity}>
                    <SelectTrigger>
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="brief">Brief</SelectItem>
                      <SelectItem value="moderate">Moderate</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>User Type</Label>
                  <Select value={userType} onValueChange={setUserType}>
                    <SelectTrigger>
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="traditional">Traditional</SelectItem>
                      <SelectItem value="ai_assisted">AI Assisted</SelectItem>
                      <SelectItem value="vibe">Vibe Coder</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          <Separator />

          {/* Continue */}
          <div className="flex justify-end">
            <Button type="button" onClick={handleContinue} disabled={!task.trim()} className="gap-1.5">
              Continue <ArrowRight className="h-4 w-4" />
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
                <span className="text-muted-foreground">Task</span>
                <span className="whitespace-pre-wrap">{task.trim()}</span>
                <span className="text-muted-foreground">Worker</span>
                <span className="font-mono">{worker}</span>
                <span className="text-muted-foreground">Max iterations</span>
                <span>{maxIterations}</span>
                <span className="text-muted-foreground">Occurrences</span>
                <span>{occurrences}</span>
                {version === "v2" && pickedCriteria.length > 0 && (
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
              </div>
            </CardContent>
          </Card>

          {/* Prompt Features */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5" />
                Detected Prompt Features
              </CardTitle>
              <CardDescription>
                {extractMutation.isPending
                  ? "Analyzing task prompt..."
                  : extraction?.cached
                    ? "Loaded from cache (same task text was analyzed before)"
                    : "Features detected by LLM analysis of the task prompt"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {extractMutation.isPending && (
                <div className="flex items-center gap-2 text-muted-foreground py-4">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Extracting prompt features…</span>
                </div>
              )}

              {extractMutation.isError && (
                <p className="text-sm text-destructive py-2">
                  {extractMutation.error instanceof Error
                    ? extractMutation.error.message
                    : "Feature extraction failed"}
                </p>
              )}

              {extraction && !extractMutation.isPending && (
                <div className="space-y-3">
                  {detectedFeatures.length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                        Detected ({detectedFeatures.length})
                      </h4>
                      <div className="flex flex-wrap gap-1.5">
                        {detectedFeatures.map((f) => (
                          <Badge key={f.featureId} variant="default" className="gap-1 font-mono text-xs">
                            <CheckCircle2 className="h-3 w-3" />
                            {f.featureId}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {notDetectedFeatures.length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                        Not detected ({notDetectedFeatures.length})
                      </h4>
                      <div className="flex flex-wrap gap-1.5">
                        {notDetectedFeatures.map((f) => (
                          <Badge key={f.featureId} variant="outline" className="gap-1 font-mono text-xs text-muted-foreground">
                            <XCircle className="h-3 w-3" />
                            {f.featureId}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {skippedFeatures.length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                        Skipped ({skippedFeatures.length})
                      </h4>
                      <div className="flex flex-wrap gap-1.5">
                        {skippedFeatures.map((f) => (
                          <Badge key={f.featureId} variant="outline" className="gap-1 font-mono text-xs text-muted-foreground/50">
                            <MinusCircle className="h-3 w-3" />
                            {f.featureId}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {extraction.promptFeatureResults.length === 0 && (
                    <p className="text-sm text-muted-foreground italic">No prompt features defined yet.</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Suggested New Features */}
          {suggestedFeatures.length > 0 && !extractMutation.isPending && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Plus className="h-4 w-4" />
                  Suggested New Features
                </CardTitle>
                <CardDescription>
                  The AI detected characteristics not covered by existing features
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {suggestedFeatures.map((s) => {
                    const alreadyCreated = createdSuggestionIds.has(s.suggestedId);
                    return (
                      <div key={s.suggestedId} className={`flex items-start justify-between gap-3 rounded-md border p-3 ${alreadyCreated ? "opacity-60" : ""}`}>
                        <div className="space-y-1 min-w-0">
                          <Badge variant="secondary" className="font-mono text-xs">
                            {s.suggestedId}
                          </Badge>
                          <p className="text-sm text-muted-foreground">{s.behavior}</p>
                        </div>
                        {alreadyCreated ? (
                          <Badge variant="outline" className="gap-1 shrink-0 text-xs">
                            <Check className="h-3 w-3" />
                            Created
                          </Badge>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1 shrink-0"
                            onClick={() => setActiveSuggestion(s)}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Create
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
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
              </Button>
            </div>
          </div>
        </form>
      )}

      {/* ─── Sheet: Create Prompt Feature Wizard ───────────────────────── */}
      <Sheet
        open={activeSuggestion !== null}
        onOpenChange={(open) => {
          if (!open) setActiveSuggestion(null);
        }}
      >
        <SheetContent side="right" className="sm:max-w-xl w-full overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Create Prompt Feature</SheetTitle>
            <SheetDescription>
              Create a new feature suggested by the extraction analysis
            </SheetDescription>
          </SheetHeader>
          {activeSuggestion && (
            <div className="mt-6">
              <PromptFeatureWizard
                key={activeSuggestion.suggestedId}
                initialBehavior={activeSuggestion.behavior}
                initialId={activeSuggestion.suggestedId}
                initialPrompt={activeSuggestion.prompt}
                onCreated={(feature) => {
                  setCreatedSuggestionIds((prev) => new Set(prev).add(activeSuggestion.suggestedId));
                  setActiveSuggestion(null);
                  toast.success(`Feature "${feature.id}" created`);
                  // Re-extract with force to pick up the new feature
                  extractMutation.mutate({ force: true });
                }}
                onCancel={() => setActiveSuggestion(null)}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
