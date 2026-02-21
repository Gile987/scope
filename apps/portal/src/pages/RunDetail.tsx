// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { ReportStatusBadge } from "@/components/ReportStatusBadge";
import { LogViewer } from "@/components/LogViewer";
import { TurnTimeline } from "@/components/TurnTimeline";
import { CriteriaGraphView } from "@/components/CriteriaGraphView";
import { useLogStream } from "@/hooks/use-log-stream";
import { ArrowLeft, Copy, Check, Sparkles, CheckCircle2, XCircle, MinusCircle, FileText, Plus } from "lucide-react";
import { formatDate, formatId } from "@/lib/utils";
import { useState } from "react";
import { toast } from "sonner";

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

  // For completed/failed/exhausted runs, use REST-fetched logs instead of SSE
  const effectiveLogs = isActive ? logStream.logs : (run?.logs ?? []);
  const effectiveIsConnected = isActive ? logStream.isConnected : false;
  const effectiveIsDone = isActive ? logStream.isDone : true;
  const effectiveError = isActive ? logStream.error : null;

  // Fetch linked prompt feature extraction (if present)
  const extractionId = run?.promptFeatureExtractionId;
  const { data: extraction } = useQuery({
    queryKey: ["prompt-feature-extraction", extractionId],
    queryFn: () => api.getPromptFeatureExtraction(extractionId!),
    enabled: !!extractionId,
  });

  // Fetch reports for this run
  const { data: reports, refetch: refetchReports } = useQuery({
    queryKey: ["run-reports", id],
    queryFn: () => api.getRunReports(id!),
    enabled: !!id,
    refetchInterval: 10_000,
  });

  const generateReport = useMutation({
    mutationFn: () => api.createReport(id!),
    onSuccess: () => {
      toast.success("Report generation queued");
      refetchReports();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to generate report");
    },
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
          <TabsTrigger value="reports">
            Reports {reports && reports.length > 0 ? `(${reports.length})` : ""}
          </TabsTrigger>
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
              logs={effectiveLogs}
            />
          )}
          <LogViewer
            runId={run._id}
            enabled={isActive}
            logs={effectiveLogs}
            isConnected={effectiveIsConnected}
            isDone={effectiveIsDone}
            error={effectiveError}
          />
        </TabsContent>

        {/* Reports tab */}
        <TabsContent value="reports" className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium">Reports</h3>
            <Button
              size="sm"
              onClick={() => generateReport.mutate()}
              disabled={generateReport.isPending}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              Generate Report
            </Button>
          </div>

          {reports && reports.length > 0 ? (
            <div className="space-y-3">
              {reports.map((report) => (
                <Card key={report._id}>
                  <CardContent className="flex items-center justify-between py-4">
                    <div className="flex items-center gap-4">
                      <FileText className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <Link
                          to={`/reports/${report._id}`}
                          className="font-mono text-sm text-primary hover:underline"
                        >
                          {formatId(report._id)}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(report.createdAt)}
                          {report.reporter?.model && ` · ${report.reporter.model}`}
                        </p>
                      </div>
                    </div>
                    <ReportStatusBadge status={report.status} />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No reports for this run yet.</p>
            </div>
          )}
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

            {/* Prompt Features card (if extraction linked) */}
            {extraction && (
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Sparkles className="h-4 w-4" /> Prompt Features
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(() => {
                    const detected = extraction.promptFeatureResults.filter((f) => f.detected);
                    const notDetected = extraction.promptFeatureResults.filter((f) => !f.detected && f.evaluated);
                    const skipped = extraction.promptFeatureResults.filter((f) => !f.evaluated);
                    return (
                      <>
                        {detected.length > 0 && (
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                              Detected ({detected.length})
                            </h4>
                            <div className="flex flex-wrap gap-1.5">
                              {detected.map((f) => (
                                <Badge key={f.featureId} variant="default" className="gap-1 font-mono text-xs">
                                  <CheckCircle2 className="h-3 w-3" />
                                  {f.featureId}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {notDetected.length > 0 && (
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                              Not detected ({notDetected.length})
                            </h4>
                            <div className="flex flex-wrap gap-1.5">
                              {notDetected.map((f) => (
                                <Badge key={f.featureId} variant="outline" className="gap-1 font-mono text-xs text-muted-foreground">
                                  <XCircle className="h-3 w-3" />
                                  {f.featureId}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {skipped.length > 0 && (
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                              Skipped ({skipped.length})
                            </h4>
                            <div className="flex flex-wrap gap-1.5">
                              {skipped.map((f) => (
                                <Badge key={f.featureId} variant="outline" className="gap-1 font-mono text-xs text-muted-foreground/50">
                                  <MinusCircle className="h-3 w-3" />
                                  {f.featureId}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </CardContent>
              </Card>
            )}

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
