// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CodebaseRevisionDocument } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Download, FileArchive, GitCommit, FolderGit2, ExternalLink } from "lucide-react";
import { formatDate } from "@/lib/utils";

export function CodebaseRevisionDetail() {
  const { id, revisionId } = useParams();
  const navigate = useNavigate();

  const { data: codebase } = useQuery({
    queryKey: ["codebase", id],
    queryFn: () => api.getCodebase(id!),
    enabled: !!id,
  });

  const { data: revision, isLoading, error } = useQuery({
    queryKey: ["codebase-revision", revisionId],
    queryFn: () => api.getCodebaseRevision(revisionId!),
    enabled: !!revisionId,
  });

  const backToCodebase = () => navigate(`/codebases/${id}`);

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  if (error || !revision) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" className="gap-1.5" onClick={backToCodebase}><ArrowLeft className="h-4 w-4" /> Back to codebase</Button>
        <div className="py-12 text-center text-muted-foreground">Revision not found</div>
      </div>
    );
  }

  const downloadUrl = `/api/v1/codebase-revisions/${revision._id}/archive`;
  const isGit = revision.sourceType === "git";

  return (
    <div className="space-y-4">
      <Button variant="ghost" className="gap-1.5" onClick={backToCodebase}>
        <ArrowLeft className="h-4 w-4" /> Back to {codebase?.name ?? "codebase"}
      </Button>

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            {isGit ? <GitCommit className="h-6 w-6" /> : <FileArchive className="h-6 w-6" />}
            <h1 className="font-mono text-2xl font-bold tracking-tight">{revision.ref}</h1>
            <Badge variant="outline" className="text-xs">{revision.sourceType}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Immutable codebase revision snapshot.</p>
        </div>
        <Button asChild className="gap-1.5">
          <a href={downloadUrl} download={`${revision.ref.replace(/[^a-zA-Z0-9_.@-]/g, "_")}.tar.gz`}>
            <Download className="h-4 w-4" /> Download archive
          </a>
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Provenance</CardTitle>
            <CardDescription>Where this snapshot came from.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Detail label="Revision"><span className="font-mono text-xs">{revision.ref}</span></Detail>
            <Detail label="Revision number"><span className="font-mono text-xs">r{revision.revisionNumber}</span></Detail>
            <Detail label="Source type"><Badge variant="outline" className="text-xs">{revision.sourceType}</Badge></Detail>
            {revision.source && (
              <Detail label="Source">
                <a href={`https://github.com/${revision.source}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
                  <FolderGit2 className="h-3 w-3" /> {revision.source} <ExternalLink className="h-3 w-3" />
                </a>
              </Detail>
            )}
            {revision.requestedRef && <Detail label="Requested ref"><span className="font-mono text-xs">{revision.requestedRef}</span></Detail>}
            {revision.resolvedCommitSha && (
              <Detail label="Commit">
                {revision.source ? (
                  <a href={`https://github.com/${revision.source}/commit/${revision.resolvedCommitSha}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
                    {revision.resolvedCommitSha} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="font-mono text-xs">{revision.resolvedCommitSha}</span>
                )}
              </Detail>
            )}
            {revision.commitTimestamp && <Detail label="Commit time"><span className="text-xs text-muted-foreground">{formatDate(revision.commitTimestamp)}</span></Detail>}
            {revision.originalFilename && <Detail label="Original filename"><span className="font-mono text-xs">{revision.originalFilename}</span></Detail>}
            {revision.contentSha256 && <Detail label="Content SHA-256"><span className="break-all font-mono text-xs">{revision.contentSha256}</span></Detail>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Snapshot</CardTitle>
            <CardDescription>The archive seeded into a run workspace.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Detail label="Files"><span className="text-xs">{revision.fileCount?.toLocaleString() ?? "—"}</span></Detail>
            <Detail label="Size"><span className="text-xs">{formatBytes(revision.sizeBytes)}</span></Detail>
            <Detail label="Archive"><span className="break-all font-mono text-xs">{revision.archiveUrl}</span></Detail>
            <Detail label="Resolved"><span className="text-xs text-muted-foreground">{formatDate(revision.resolvedAt)}</span></Detail>
            <Detail label="Created"><span className="text-xs text-muted-foreground">{formatDate(revision.createdAt)}</span></Detail>
            {revision.creator && <Detail label="Creator"><span className="text-xs">{revision.creator}</span></Detail>}
            <Detail label="Revision ID"><span className="break-all font-mono text-xs text-muted-foreground">{revision._id}</span></Detail>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><span className="text-xs text-muted-foreground">{label}</span><div className="break-all">{children}</div></div>;
}

function formatBytes(value?: number): string {
  if (value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && size >= 1024; i += 1) {
    size /= 1024;
    unit = units[i];
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
}

export type { CodebaseRevisionDocument };
