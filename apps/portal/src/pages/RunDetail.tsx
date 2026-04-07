// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { StatusBadge, OutcomeBadge } from "@/components/StatusBadge";
import { ReportStatusBadge } from "@/components/ReportStatusBadge";
import { LogViewer } from "@/components/LogViewer";
import { TurnTimeline } from "@/components/TurnTimeline";
import { CriteriaGraphView } from "@/components/CriteriaGraphView";
import { HarNetworkViewer } from "@/components/HarNetworkViewer";
import { ConversationView } from "@/components/ConversationView";
import { VideoPlayer } from "@/components/VideoPlayer";
import { useLogStream } from "@/hooks/use-log-stream";
import { useAllTurnsToolCalls } from "@/hooks/useHarExtraction";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { ReportThumbnail } from "@/components/ReportThumbnail";
import { ArrowLeft, Copy, Check, Sparkles, CheckCircle2, XCircle, MinusCircle, FileText, Plus, Download, Loader2, Archive, Video, LayoutGrid, List } from "lucide-react";
import { formatDate, formatId, formatDuration } from "@/lib/utils";
import { useState, useMemo } from "react";
import { toast } from "sonner";

export function RunDetail() {
  const { id, tab } = useParams<{ id: string; tab?: string }>();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [reportsView, setReportsView] = useState<"grid" | "list">("grid");
  const [reportsFilter, setReportsFilter] = useState<"latest" | "all">("latest");

  const { data: run, isLoading, error } = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.getRun(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Stop polling once terminal (done)
      if (status === "done") return false;
      return 5_000;
    },
  });

  const isActive = run?.status === "pending" || run?.status === "processing";
  // Note: "done" is terminal — not active, no log streaming needed

  // Lift the log stream so it can be shared between LogViewer and CriteriaGraphView
  // Must be called unconditionally (before any early returns) per Rules of Hooks
  const logStream = useLogStream({
    id: run?._id ?? "",
    enabled: isActive && !!run,
    fromStart: true,
  });

  // For completed/failed/finished runs, use REST-fetched logs instead of SSE
  const effectiveLogs = isActive ? logStream.logs : (run?.logs ?? []);
  const effectiveIsConnected = isActive ? logStream.isConnected : false;
  const effectiveIsDone = isActive ? logStream.isDone : true;
  const effectiveError = isActive ? logStream.error : null;

  // Fetch linked task prompt (if present) — provides prompt features
  const taskPromptId = run?.taskPromptId;
  const { data: taskPrompt } = useQuery({
    queryKey: ["task-prompt", taskPromptId],
    queryFn: () => api.getTaskPrompt(taskPromptId!),
    enabled: !!taskPromptId,
  });

  // Fetch reports for this run
  const { data: reports, refetch: refetchReports } = useQuery({
    queryKey: ["run-reports", id],
    queryFn: () => api.getRunReports(id!),
    enabled: !!id,
    refetchInterval: 10_000,
  });

  // Fetch report templates for name resolution
  const { data: reportTemplates } = useQuery({
    queryKey: ["report-templates"],
    queryFn: () => api.listReportTemplates(),
  });
  const templateMap = new Map(reportTemplates?.map((t) => [t.id, t.name]));

  // Filter reports: "latest" keeps only the most recent per templateId
  const filteredReports = useMemo(() => {
    if (!reports) return [];
    if (reportsFilter === "all") return reports;
    const seen = new Map<string, boolean>();
    return reports
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .filter((r) => {
        const key = r.templateId ?? r._id; // manual reports always shown
        if (seen.has(key)) return false;
        seen.set(key, true);
        return true;
      });
  }, [reports, reportsFilter]);

  const generateReport = useMutation({
    mutationFn: () => api.triggerReports(id!),
    onSuccess: (data) => {
      toast.success(`${data.triggered} report(s) queued`);
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
        <Link to="/runs">
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
  const hasHarData = !!(run.harUrl || run.turns?.some(t => t.harUrl));
  const hasVideoData = !!(run.videoUrls?.length || run.setupVideoUrls?.length || run.turns?.some(t => t.videoUrls?.length));
  const videoCount = (run.setupVideoUrls?.length ?? 0)
    + (run.videoUrls?.length ?? 0)
    + (run.turns?.reduce((n, t) => n + (t.videoUrls?.length ?? 0), 0) ?? 0);

  // Compute aggregate token usage: for one-shot runs use run.tokenUsage,
  // for multi-turn runs sum per-turn token usage
  const totalTokenUsage = run.tokenUsage
    ?? (run.turns?.some(t => t.tokenUsage)
      ? run.turns!.reduce(
          (acc, t) => {
            if (!t.tokenUsage) return acc;
            return {
              promptTokens: acc.promptTokens + t.tokenUsage.promptTokens,
              completionTokens: acc.completionTokens + t.tokenUsage.completionTokens,
              totalTokens: acc.totalTokens + t.tokenUsage.totalTokens,
            };
          },
          { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
        )
      : undefined);

  return (
    <div className="space-y-6">
      {/* Back link + header */}
      <div>
        <Link to="/runs">
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
              {run.status === "done" && <OutcomeBadge outcome={run.outcome} />}
              <span className="font-mono">{run.workerType}</span>
              {run.model && (
                <>
                  <Separator orientation="vertical" className="h-4" />
                  <span className="font-mono">{run.model}</span>
                </>
              )}
              {run.agentVersion && (
                <>
                  <Separator orientation="vertical" className="h-4" />
                  <span className="font-mono text-xs cursor-default" title={run.workerVersion ? `Worker: ${run.workerVersion}` : undefined}>{run.agentVersion}</span>
                </>
              )}
              <Separator orientation="vertical" className="h-4" />
              <span>Created {formatDate(run.createdAt)}</span>
              {run.maxIterations && (
                <>
                  <Separator orientation="vertical" className="h-4" />
                  <span>Max {run.maxIterations} iterations</span>
                </>
              )}
              {(() => {
                const totalDuration = run.turns?.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
                return totalDuration ? (
                  <>
                    <Separator orientation="vertical" className="h-4" />
                    <span className="font-mono text-xs" title={`${totalDuration.toLocaleString()}ms total`}>
                      {formatDuration(totalDuration)}
                    </span>
                  </>
                ) : null;
              })()}
              {totalTokenUsage && (
                <>
                  <Separator orientation="vertical" className="h-4" />
                  <span className="font-mono text-xs">
                    {totalTokenUsage.promptTokens.toLocaleString()}↑ · {totalTokenUsage.completionTokens.toLocaleString()}↓
                  </span>
                </>
              )}
              {run.mcpServers && run.mcpServers.length > 0 && (
                <>
                  <Separator orientation="vertical" className="h-4" />
                  <span>MCP:</span>
                  {run.mcpServers.map((slug) => (
                    <Link key={slug} to={`/mcp-servers/${slug}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
                      {slug}
                    </Link>
                  ))}
                </>
              )}
              {run.skills && run.skills.length > 0 && (
                <>
                  <Separator orientation="vertical" className="h-4" />
                  <span>Skills:</span>
                  {run.skills.map((slug) => (
                    <Link key={slug} to={`/skills/${slug}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
                      {slug}
                    </Link>
                  ))}
                </>
              )}
              {run.extensions && run.extensions.length > 0 && (
                <>
                  <Separator orientation="vertical" className="h-4" />
                  <span>Extensions:</span>
                  {run.extensions.map((id) => (
                    <Link key={id} to={`/extensions/${id}`} className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono hover:bg-accent transition-colors">
                      {id}
                    </Link>
                  ))}
                </>
              )}
            </div>
          </div>
          {run.turns && run.turns.some(t => t.snapshotUrl) && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => window.open(api.archiveUrl(run._id), "_blank")}
            >
              <Archive className="h-4 w-4" />
              Download Archive
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={tab || (run.turns && run.turns.length > 0 ? "turns" : "logs")}
        onValueChange={(value) => navigate(`/runs/${id}/${value}`)}
      >
        <TabsList>
          <TabsTrigger value="turns">
            Turns {run.turns ? `(${run.turns.length})` : ""}
          </TabsTrigger>
          {run.turns && run.turns.length > 0 && (
            <TabsTrigger value="conversation">Conversation</TabsTrigger>
          )}
          {hasHarData && <TabsTrigger value="network">Network</TabsTrigger>}
          {hasHarData && <TabsTrigger value="tool-calls">Tool Calls</TabsTrigger>}
          {hasVideoData && <TabsTrigger value="video"><Video className="h-3.5 w-3.5 mr-1" />Videos ({videoCount})</TabsTrigger>}
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

        {/* Conversation tab — chat-style view of agent/judge exchanges */}
        {run.turns && run.turns.length > 0 && (
          <TabsContent value="conversation" className="mt-4">
            <ConversationView turns={run.turns} task={run.scenario?.task} runId={run._id} />
          </TabsContent>
        )}

        {/* Network tab — Chrome DevTools-style HAR viewer */}
        {hasHarData && (
          <TabsContent value="network" className="mt-4">
            {/* If multi-turn, show per-iteration selector; otherwise one viewer */}
            {run.turns && run.turns.some(t => t.harUrl) ? (
              <HarIterationTabs runId={run._id} turns={run.turns} />
            ) : (
              <HarNetworkViewer runId={run._id} />
            )}
          </TabsContent>
        )}

        {/* Video tab — session recording player */}
        {hasVideoData && (
          <TabsContent value="video" className="mt-4">
            {run.turns && run.turns.some(t => t.videoUrls?.length) ? (
              <VideoIterationTabs runId={run._id} turns={run.turns} setupVideoUrls={run.setupVideoUrls} />
            ) : (
              <div className="space-y-4">
                {run.setupVideoUrls && run.setupVideoUrls.length > 0 && (
                  run.setupVideoUrls.map((_, i) => (
                    <VideoPlayer key={`setup-${i}`} src={api.videoUrl(run._id, undefined, i, "setup")} label="Setup" />
                  ))
                )}
                {run.videoUrls && run.videoUrls.length > 0 && (
                  run.videoUrls.map((_, i) => (
                    <VideoPlayer key={i} src={api.videoUrl(run._id, undefined, i)} label={run.videoUrls!.length > 1 ? `Video ${i + 1}` : undefined} />
                  ))
                )}
              </div>
            )}
          </TabsContent>
        )}

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
            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-md border">
                <Button
                  variant={reportsFilter === "latest" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8 rounded-r-none text-xs"
                  onClick={() => setReportsFilter("latest")}
                >
                  Latest
                </Button>
                <Button
                  variant={reportsFilter === "all" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8 rounded-l-none text-xs"
                  onClick={() => setReportsFilter("all")}
                >
                  All{reports && reports.length > 0 ? ` (${reports.length})` : ""}
                </Button>
              </div>
              <div className="flex items-center rounded-md border">
                <Button
                  variant={reportsView === "grid" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8 rounded-r-none"
                  onClick={() => setReportsView("grid")}
                  aria-label="Grid view"
                >
                  <LayoutGrid className="h-4 w-4" />
                </Button>
                <Button
                  variant={reportsView === "list" ? "secondary" : "ghost"}
                  size="icon"
                  className="h-8 w-8 rounded-l-none"
                  onClick={() => setReportsView("list")}
                  aria-label="List view"
                >
                  <List className="h-4 w-4" />
                </Button>
              </div>
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
          </div>

          {filteredReports.length > 0 ? (
            reportsView === "grid" ? (
              <div className="flex flex-wrap gap-4">
                {filteredReports.map((report) => (
                  <Link
                    key={report._id}
                    to={`/reports/${report._id}`}
                    className="group block"
                  >
                    <div className="flex flex-col items-center gap-2 w-[280px]">
                      {report.status === "completed" && report.content ? (
                        <ReportThumbnail content={report.content} />
                      ) : (
                        <div className="flex items-center justify-center rounded border bg-muted/30 shadow-sm" style={{ width: 280, height: 360 }}>
                          {report.status === "generating" ? (
                            <Loader2 className="h-8 w-8 text-muted-foreground animate-spin" />
                          ) : (
                            <FileText className="h-8 w-8 text-muted-foreground opacity-50" />
                          )}
                        </div>
                      )}
                      <div className="text-center w-full">
                        <p className="text-xs font-medium truncate group-hover:underline">
                          {report.templateId ? (templateMap.get(report.templateId) ?? report.templateId) : "Manual report"}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">{formatDate(report.createdAt)}</p>
                        <div className="flex items-center justify-center gap-1.5 mt-0.5">
                          <ReportStatusBadge status={report.status} />
                        </div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {filteredReports.map((report) => (
                  <Card key={report._id}>
                    <CardContent className="flex items-center justify-between py-4">
                      <div className="flex items-center gap-4">
                        <FileText className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <Link
                            to={`/reports/${report._id}`}
                            className="text-sm font-medium text-primary hover:underline"
                          >
                            {report.templateId ? (templateMap.get(report.templateId) ?? report.templateId) : "Manual report"}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(report.createdAt)}
                            {report.reporter?.model && ` · ${report.reporter.model}`}
                            {" · "}
                            <span className="font-mono">{formatId(report._id)}</span>
                          </p>
                        </div>
                      </div>
                      <ReportStatusBadge status={report.status} />
                    </CardContent>
                  </Card>
                ))}
              </div>
            )
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

            {/* Prompt Features card (if task prompt has features) */}
            {(run.agentVersion || run.workerVersion) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Version Info</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {run.agentVersion && (
                    <div>
                      <span className="text-muted-foreground">Agent Version:</span>{" "}
                      <span className="font-mono font-medium">{run.agentVersion}</span>
                    </div>
                  )}
                  {run.workerVersion && (
                    <div>
                      <span className="text-muted-foreground">Worker Version:</span>{" "}
                      <span className="font-mono font-medium">{run.workerVersion}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">Worker Type:</span>{" "}
                    <span className="font-mono font-medium">{run.workerType}</span>
                  </div>
                  {run.model && (
                    <div>
                      <span className="text-muted-foreground">Model:</span>{" "}
                      <span className="font-mono font-medium">{run.model}</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Prompt Features card (if task prompt has features) */}
            {taskPrompt?.features && taskPrompt.features.length > 0 && (
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Sparkles className="h-4 w-4" /> Prompt Features
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(() => {
                    const detected = taskPrompt.features!.filter((f) => f.detected);
                    const notDetected = taskPrompt.features!.filter((f) => !f.detected && f.evaluated);
                    const skipped = taskPrompt.features!.filter((f) => !f.evaluated);
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
                <CardContent className="prose prose-sm dark:prose-invert max-w-none">
                  <MarkdownRenderer>{run.result}</MarkdownRenderer>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* Tool Calls tab — HAR captures & tool calls summary */}
        {hasHarData && (
          <TabsContent value="tool-calls" className="mt-4 space-y-4">
            <ToolCallsTab runId={run._id} turns={run.turns} harUrl={run.harUrl} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: per-iteration HAR viewer tabs for multi-turn runs
// ---------------------------------------------------------------------------

function HarIterationTabs({ runId, turns }: { runId: string; turns: { iteration: number; harUrl?: string }[] }) {
  const turnsWithHar = turns.filter(t => t.harUrl);
  const [activeIteration, setActiveIteration] = useState(turnsWithHar[0]?.iteration);

  if (turnsWithHar.length === 0) return null;

  // Single iteration — no sub-tabs needed
  if (turnsWithHar.length === 1) {
    return <HarNetworkViewer runId={runId} iteration={turnsWithHar[0].iteration} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5 flex-wrap">
        {turnsWithHar.map(t => (
          <Button
            key={t.iteration}
            variant={activeIteration === t.iteration ? "default" : "outline"}
            size="sm"
            className="font-mono text-xs"
            onClick={() => setActiveIteration(t.iteration)}
          >
            Iteration {t.iteration}
          </Button>
        ))}
      </div>
      {activeIteration !== undefined && (
        <HarNetworkViewer runId={runId} iteration={activeIteration} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: per-iteration video player tabs for multi-turn runs
// ---------------------------------------------------------------------------

function VideoIterationTabs({ runId, turns, setupVideoUrls }: { runId: string; turns: { iteration: number; videoUrls?: string[] }[]; setupVideoUrls?: string[] }) {
  const turnsWithVideo = turns.filter(t => t.videoUrls && t.videoUrls.length > 0);
  const hasSetupVideo = setupVideoUrls && setupVideoUrls.length > 0;
  const [activeTab, setActiveTab] = useState<string>(hasSetupVideo ? "setup" : String(turnsWithVideo[0]?.iteration));

  if (turnsWithVideo.length === 0 && !hasSetupVideo) return null;

  const activeTurn = turnsWithVideo.find(t => String(t.iteration) === activeTab);

  return (
    <div className="space-y-3">
      {(hasSetupVideo || turnsWithVideo.length > 1) && (
        <div className="flex gap-1.5 flex-wrap">
          {hasSetupVideo && (
            <Button
              variant={activeTab === "setup" ? "default" : "outline"}
              size="sm"
              className="font-mono text-xs"
              onClick={() => setActiveTab("setup")}
            >
              Setup
            </Button>
          )}
          {turnsWithVideo.map(t => (
            <Button
              key={t.iteration}
              variant={activeTab === String(t.iteration) ? "default" : "outline"}
              size="sm"
              className="font-mono text-xs"
              onClick={() => setActiveTab(String(t.iteration))}
            >
              Iteration {t.iteration}
            </Button>
          ))}
        </div>
      )}
      {activeTab === "setup" && hasSetupVideo && (
        <div className="space-y-4">
          {setupVideoUrls.map((_, i) => (
            <VideoPlayer
              key={`setup-${i}`}
              src={api.videoUrl(runId, undefined, i, "setup")}
              label={setupVideoUrls.length > 1 ? `Setup Video ${i + 1}` : "Setup"}
            />
          ))}
        </div>
      )}
      {activeTab !== "setup" && activeTurn && (
        <div className="space-y-4">
          {activeTurn.videoUrls!.map((_, i) => (
            <VideoPlayer
              key={`${activeTab}-${i}`}
              src={api.videoUrl(runId, Number(activeTab), i)}
              label={activeTurn.videoUrls!.length > 1 ? `Video ${i + 1}` : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool Calls tab — extracts tool calls from HAR client-side
// ---------------------------------------------------------------------------

import type { ConversationTurn } from "@/types";

/** Truncated text cell that expands on click when content overflows. */
function ExpandableCell({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`cursor-pointer ${expanded ? "whitespace-pre-wrap break-all" : "truncate max-w-sm"} ${className}`}
      onClick={() => setExpanded(!expanded)}
      title={expanded ? "Click to collapse" : "Click to expand"}
    >
      {children}
    </div>
  );
}

function ToolCallsTab({ runId, turns, harUrl }: { runId: string; turns?: ConversationTurn[]; harUrl?: string }) {
  const { allToolCalls, isLoading } = useAllTurnsToolCalls(runId, turns, harUrl);

  // Group by tool name for summary
  const byName = new Map<string, number>();
  for (const tc of allToolCalls) {
    byName.set(tc.name, (byName.get(tc.name) ?? 0) + 1);
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">Network Captures</h3>
        {harUrl && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => window.open(api.harUrl(runId), "_blank")}
          >
            <Download className="h-4 w-4" />
            Download HAR
          </Button>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Extracting tool calls from HAR…</span>
        </div>
      )}

      {!isLoading && allToolCalls.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <p>No tool calls captured. HAR file may still be available for download.</p>
        </div>
      )}

      {allToolCalls.length > 0 && (
        <div className="space-y-4">
          {/* Summary badges */}
          <div className="flex flex-wrap gap-2">
            {Array.from(byName.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([name, count]) => (
                <Badge key={name} variant="secondary" className="font-mono text-xs gap-1">
                  {name} <span className="text-muted-foreground">×{count}</span>
                </Badge>
              ))}
          </div>

          {/* Full tool calls table */}
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left p-3 font-medium">Iteration</th>
                      <th className="text-left p-3 font-medium">Tool</th>
                      <th className="text-left p-3 font-medium">Arguments</th>
                      <th className="text-left p-3 font-medium">Response</th>
                      <th className="text-left p-3 font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allToolCalls.map((tc, idx) => (
                      <tr key={tc.id || idx} className="border-b last:border-0">
                        <td className="p-3 text-xs text-muted-foreground">
                          {tc._iteration ?? "–"}
                        </td>
                        <td className="p-3">
                          <span className="font-mono text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                            {tc.name}
                          </span>
                        </td>
                        <td className="p-3">
                          <table className="text-xs border-collapse">
                            <tbody>
                              {Object.entries(tc.arguments).map(([key, val]) => (
                                <tr key={key} className="border-b border-border/50 last:border-0">
                                  <td className="pr-2 py-1 text-foreground/70 font-medium whitespace-nowrap align-top border-r border-border/50">{key}</td>
                                  <td className="pl-2 py-1 font-mono text-muted-foreground"><ExpandableCell>{typeof val === "string" ? val : JSON.stringify(val)}</ExpandableCell></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                        <td className="p-3 text-xs font-mono text-muted-foreground">
                          {tc.response ? (
                            <ExpandableCell className="max-w-md">{tc.response}</ExpandableCell>
                          ) : (
                            <span>–</span>
                          )}
                        </td>
                        <td className="p-3">
                          {tc.response ? (
                            <pre className="text-xs text-muted-foreground max-w-md truncate">
                              {tc.response}
                            </pre>
                          ) : (
                            <span className="text-xs text-muted-foreground">–</span>
                          )}
                        </td>
                        <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                          {tc.timestamp ? new Date(tc.timestamp).toLocaleTimeString() : "–"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Per-turn HAR download links */}
          {turns && turns.some(t => t.harUrl) && (
            <div>
              <h4 className="text-sm font-medium mb-2">Per-Turn HAR Files</h4>
              <div className="flex flex-wrap gap-2">
                {turns.filter(t => t.harUrl).map(t => (
                  <Button
                    key={t.iteration}
                    variant="outline"
                    size="sm"
                    className="gap-1 font-mono text-xs"
                    onClick={() => window.open(api.harUrl(runId, t.iteration), "_blank")}
                  >
                    <Download className="h-3 w-3" />
                    Iteration {t.iteration}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
