// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Send, Loader2 } from "lucide-react";
import { WORKER_TYPES } from "@/types";
import { CriteriaPicker } from "@/components/CriteriaPicker";

export function SubmitRun() {
  const navigate = useNavigate();

  // Form state
  const [task, setTask] = useState("");
  const [criteriaText, setCriteriaText] = useState("");
  const [pickedCriteria, setPickedCriteria] = useState<string[]>([]);
  const [version, setVersion] = useState<"v1" | "v2">("v2");
  const [worker, setWorker] = useState<string>("coder-acp-copilot");
  const [maxIterations, setMaxIterations] = useState<string>("10");

  // Optional persona
  const [personality, setPersonality] = useState<string>("");
  const [experience, setExperience] = useState<string>("");
  const [verbosity, setVerbosity] = useState<string>("");
  const [userType, setUserType] = useState<string>("");

  const submitMutation = useMutation({
    mutationFn: api.submitRun,
    onSuccess: (data) => {
      navigate(`/runs/${data.id}`);
    },
  });

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
      maxIterations: parseInt(maxIterations, 10) || undefined,
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
    });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New Run</h1>
        <p className="text-muted-foreground">Submit a benchmark run to a coding agent worker</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
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
          <CardContent>
            <div className="space-y-2">
              <Label htmlFor="worker">Worker Type *</Label>
              <Select value={worker} onValueChange={setWorker}>
                <SelectTrigger id="worker">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKER_TYPES.map((w) => (
                    <SelectItem key={w} value={w}>
                      {w}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

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

        {/* Submit */}
        <div className="flex items-center justify-between">
          {submitMutation.isError && (
            <p className="text-sm text-destructive">
              {submitMutation.error instanceof Error ? submitMutation.error.message : "Submission failed"}
            </p>
          )}
          <div className="flex-1" />
          <Button type="submit" disabled={!task.trim() || submitMutation.isPending} className="gap-1.5">
            {submitMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Submit Run
          </Button>
        </div>
      </form>
    </div>
  );
}
