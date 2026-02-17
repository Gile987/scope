// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { LogViewer } from "@/components/LogViewer";
import { TurnTimeline } from "@/components/TurnTimeline";
import { CriteriaGraphView } from "@/components/CriteriaGraphView";
import { useLogStream } from "@/hooks/use-log-stream";
import { ArrowLeft, Copy, Check } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useState } from "react";

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const [copied, setCopied] = useState(false);

  const { data: run, isLoading, error } = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.getRun(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Stop polling once terminal (completed, failed, or exhausted)
      if (status === "completed" || status === "failed" || status === "exhausted") return false;
      return 5_000;
    },
  });

  const isActive = run?.status === "pending" || run?.status === "processing" || run?.status === "iterating";
  // Note: "exhausted" is terminal — not active, no log streaming needed

  // Lift the log stream so it can be shared between LogViewer and CriteriaGraphView
  // Must be called unconditionally (before any early returns) per Rules of Hooks
  const logStream = useLogStream({
    id: run?._id ?? "",
    enabled: isActive && !!run,
    fromStart: true,
  });

  const copyId = () => {
    navigator.clipboard.writeText(id ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="space-y-4">
        <Link to="/">
          <Button variant="ghost" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Back to runs
          </Button>
        </Link>
        <div className="text-center py-12 text-destructive">
          {error instanceof Error ? error.message : "Run not found"}
        </div>
      </div>
    );
  }

  const isV2 = run.scenario?.version === "v2";

  return (
    <div className="space-y-6">
      {/* Back link + header */}
      <div>
        <Link to="/">
          <Button variant="ghost" size="sm" className="gap-1.5 mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to runs
          </Button>
        </Link>

        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight font-mono">{id}</h1>
              <button
                onClick={copyId}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Copy run ID"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <StatusBadge status={run.status} />
              <span className="font-mono">{run.workerType}</span>
              <Separator orientation="vertical" className="h-4" />
              <span>Created {formatDate(run.createdAt)}</span>
              {run.maxIterations && (
                <>
                  <Separator orientation="vertical" className="h-4" />
                  <span>Max {run.maxIterations} iterations</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue={run.turns && run.turns.length > 0 ? "turns" : "logs"}>
        <TabsList>
          <TabsTrigger value="turns">
            Turns {run.turns ? `(${run.turns.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>

        {/* Turns tab */}
        <TabsContent value="turns" className="mt-4">
          <TurnTimeline turns={run.turns ?? []} runId={run._id} />
        </TabsContent>

        {/* Logs tab */}
        <TabsContent value="logs" className="mt-4 space-y-4">
          {isV2 && run.scenario?.criteria && run.scenario.criteria.length > 0 && (
            <CriteriaGraphView
              scenarioCriteria={run.scenario!.criteria}
              logs={logStream.logs}
            />
          )}
          <LogViewer
            runId={run._id}
            enabled={isActive}
            logs={logStream.logs}
            isConnected={logStream.isConnected}
            isDone={logStream.isDone}
            error={logStream.error}
          />
        </TabsContent>

        {/* Details tab */}
        <TabsContent value="details" className="mt-4">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Scenario card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Scenario</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <h4 className="text-sm font-medium mb-1">Task</h4>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{run.scenario?.task ?? "–"}</p>
                </div>
                {run.scenario?.version && (
                  <div>
                    <h4 className="text-sm font-medium mb-1">Version</h4>
                    <Badge variant="outline">{run.scenario!.version}</Badge>
                  </div>
                )}
                {(run.scenario?.criteria?.length ?? 0) > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-1">Criteria ({run.scenario?.criteria?.length})</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {run.scenario?.criteria?.map((c, i) => (
                        <Badge key={i} variant="secondary" className="font-mono text-xs">
                          {c}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Persona card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Persona</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {run.persona ? (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="text-muted-foreground">Personality:</span>{" "}
                      <span className="font-medium">{run.persona.personality}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Experience:</span>{" "}
                      <span className="font-medium">{run.persona.experience}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Verbosity:</span>{" "}
                      <span className="font-medium">{run.persona.verbosity}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Type:</span>{" "}
                      <span className="font-medium">{run.persona.type}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">No persona configured</p>
                )}
                {run.personaInstructions && (
                  <div>
                    <h4 className="text-sm font-medium mb-1">Instructions</h4>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap bg-muted/50 rounded-md p-3 max-h-48 overflow-y-auto">
                      {run.personaInstructions}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Error card (if failed) */}
            {run.error && (
              <Card className="md:col-span-2 border-destructive">
                <CardHeader>
                  <CardTitle className="text-lg text-destructive">Error</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="text-sm text-destructive whitespace-pre-wrap font-mono bg-destructive/10 rounded-md p-3">
                    {run.error}
                  </pre>
                </CardContent>
              </Card>
            )}

            {/* Result card */}
            {run.result && (
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="text-lg">Result</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm whitespace-pre-wrap">{run.result}</p>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
