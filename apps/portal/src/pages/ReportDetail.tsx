// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ReportStatusBadge } from "@/components/ReportStatusBadge";
import { LogViewer } from "@/components/LogViewer";
import { useLogStream } from "@/hooks/use-log-stream";
import { ArrowLeft, Copy, Check, ExternalLink, ClipboardCopy } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkGithubAlerts from "remark-github-markdown-alerts";

export function ReportDetail() {
  const { id } = useParams<{ id: string }>();
  const [copied, setCopied] = useState(false);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [activeTab, setActiveTab] = useState("logs");
  const [reportSeen, setReportSeen] = useState(false);

  const { data: report, isLoading, error } = useQuery({
    queryKey: ["report", id],
    queryFn: () => api.getReport(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "completed" || status === "failed") return false;
      return 5_000;
    },
  });

  const isActive = report?.status === "pending" || report?.status === "generating";

  const logStream = useLogStream({
    id: report?._id ?? "",
    enabled: isActive && !!report,
    fromStart: true,
    urlBuilder: api.reportLogsUrl,
  });

  // For completed/failed reports, use REST-fetched logs instead of SSE
  const effectiveLogs = isActive ? logStream.logs : (report?.logs ?? []);
  const effectiveIsConnected = isActive ? logStream.isConnected : false;
  const effectiveIsDone = isActive ? logStream.isDone : true;
  const effectiveError = isActive ? logStream.error : null;

  const copyId = () => {
    navigator.clipboard.writeText(id ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Set initial tab to "report" if content is already available on first load
  const initialTabSet = useRef(false);
  useEffect(() => {
    if (!initialTabSet.current && report) {
      initialTabSet.current = true;
      if (report.content) {
        setActiveTab("report");
        setReportSeen(true);
      }
    }
  }, [report]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="space-y-4">
        <Link to="/reports">
          <Button variant="ghost" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Back to reports
          </Button>
        </Link>
        <div className="text-center py-12 text-destructive">
          {error instanceof Error ? error.message : "Report not found"}
        </div>
      </div>
    );
  }

  const showReportReady = report.status === "completed" && !reportSeen;

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    if (tab === "report") setReportSeen(true);
  };

  return (
    <div className="space-y-6">
      {/* Back link + header */}
      <div>
        <Link to="/reports">
          <Button variant="ghost" size="sm" className="gap-1.5 mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to reports
          </Button>
        </Link>

        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight font-mono">{id}</h1>
              <button
                onClick={copyId}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Copy report ID"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <ReportStatusBadge status={report.status} />
              <Link
                to={`/runs/${report.requestId}`}
                className="flex items-center gap-1 hover:text-foreground transition-colors"
              >
                <span className="font-mono">Run: {report.requestId.slice(0, 8)}…</span>
                <ExternalLink className="h-3 w-3" />
              </Link>
              <span>Created {formatDate(report.createdAt)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="report" className="gap-1.5">
            Report
            {showReportReady && (
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            )}
          </TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>

        {/* Report tab — rendered markdown */}
        <TabsContent value="report" className="mt-4">
          {report.content ? (
            <Card>
              <div className="flex justify-end px-6 pt-4">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground"
                  onClick={() => {
                    navigator.clipboard.writeText(report.content!);
                    setCopiedMarkdown(true);
                    setTimeout(() => setCopiedMarkdown(false), 2000);
                  }}
                >
                  {copiedMarkdown ? (
                    <><Check className="h-4 w-4 text-emerald-500" /> Copied!</>
                  ) : (
                    <><ClipboardCopy className="h-4 w-4" /> Copy Markdown</>
                  )}
                </Button>
              </div>
              <CardContent className="prose dark:prose-invert max-w-none pt-2">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkGithubAlerts]} rehypePlugins={[rehypeRaw]}>{report.content}</ReactMarkdown>
              </CardContent>
            </Card>
          ) : report.status === "pending" || report.status === "generating" ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">
                Report is being generated. Check the{" "}
                <span className="font-medium">Logs</span> tab for progress.
              </p>
            </div>
          ) : (
            <div className="text-center py-12 text-destructive">
              Report generation failed.
              {report.error && (
                <pre className="mt-2 text-sm whitespace-pre-wrap font-mono bg-destructive/10 rounded-md p-3 inline-block">
                  {report.error}
                </pre>
              )}
            </div>
          )}
        </TabsContent>

        {/* Logs tab */}
        <TabsContent value="logs" className="mt-4">
          <LogViewer
            runId={report._id}
            enabled={isActive}
            logs={effectiveLogs}
            isConnected={effectiveIsConnected}
            isDone={effectiveIsDone}
            error={effectiveError}
          />
        </TabsContent>

        {/* Details tab */}
        <TabsContent value="details" className="mt-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Reporter</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {report.reporter ? (
                  <>
                    <div>
                      <span className="text-muted-foreground">Name:</span>{" "}
                      <span className="font-medium">{report.reporter.name}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Model:</span>{" "}
                      <Badge variant="outline">{report.reporter.model}</Badge>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Agent:</span>{" "}
                      <span className="font-mono">{report.reporter.agentId}@{report.reporter.agentVersion}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Git Hash:</span>{" "}
                      <span className="font-mono text-xs">{report.reporter.gitHash}</span>
                    </div>
                  </>
                ) : (
                  <p className="text-muted-foreground italic">Not yet assigned</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Metadata</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Report ID:</span>{" "}
                  <span className="font-mono">{report._id}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Run ID:</span>{" "}
                  <Link
                    to={`/runs/${report.requestId}`}
                    className="font-mono text-primary hover:underline"
                  >
                    {report.requestId}
                  </Link>
                </div>
                <div>
                  <span className="text-muted-foreground">Created:</span>{" "}
                  <span>{formatDate(report.createdAt)}</span>
                </div>
                {report.updatedAt && (
                  <div>
                    <span className="text-muted-foreground">Updated:</span>{" "}
                    <span>{formatDate(report.updatedAt)}</span>
                  </div>
                )}
              </CardContent>
            </Card>

            {report.error && (
              <Card className="md:col-span-2 border-destructive">
                <CardHeader>
                  <CardTitle className="text-lg text-destructive">Error</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="text-sm text-destructive whitespace-pre-wrap font-mono bg-destructive/10 rounded-md p-3">
                    {report.error}
                  </pre>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
