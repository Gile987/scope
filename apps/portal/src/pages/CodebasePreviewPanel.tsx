// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FolderGit2 } from "lucide-react";
import { api } from "@/lib/api";
import { DetailPanel } from "@/components/list-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";

interface CodebasePreviewPanelProps {
  id: string;
}

export function CodebasePreviewPanel({ id }: CodebasePreviewPanelProps) {
  const navigate = useNavigate();
  const { data: codebase, isLoading, error } = useQuery({
    queryKey: ["codebase", id],
    queryFn: () => api.getCodebase(id),
    enabled: !!id,
  });

  const closePanel = () => {
    const params = new URLSearchParams(window.location.search);
    params.delete("preview");
    const search = params.toString();
    navigate({ pathname: "/codebases", search: search ? `?${search}` : "" });
  };

  if (isLoading) {
    return (
      <DetailPanel title="Loading…" onClose={closePanel}>
        <div className="space-y-3"><Skeleton className="h-5 w-3/4" /><Skeleton className="h-32 w-full" /></div>
      </DetailPanel>
    );
  }

  if (error || !codebase) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Codebase not found.</p>
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title={<span className="flex items-center gap-1.5 truncate"><FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate">{codebase.name}</span></span>}
      subtitle={<span className="font-mono">{codebase.slug}</span>}
      onClose={closePanel}
      headerActions={<div className="flex justify-end"><Link to={`/codebases/${codebase._id}`}><Button variant="outline" size="sm" className="gap-1.5"><ExternalLink className="h-3.5 w-3.5" /> Open full view</Button></Link></div>}
    >
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Identity</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div><dt className="text-xs text-muted-foreground">Source type</dt><dd className="mt-0.5"><Badge variant="outline" className="text-xs">{codebase.sourceType}</Badge></dd></div>
              {codebase.source && <div><dt className="text-xs text-muted-foreground">Source</dt><dd className="mt-0.5 break-all font-mono text-xs">{codebase.source}</dd></div>}
              {codebase.defaultBranch && <div><dt className="text-xs text-muted-foreground">Default branch</dt><dd className="mt-0.5 font-mono text-xs">{codebase.defaultBranch}</dd></div>}
              <div><dt className="text-xs text-muted-foreground">Latest revision</dt><dd className="mt-0.5 font-mono text-xs">{codebase.revisionCounter > 0 ? `${codebase.slug}@r${codebase.revisionCounter}` : "None"}</dd></div>
            </dl>
          </CardContent>
        </Card>
        {codebase.description && <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Description</CardTitle></CardHeader><CardContent><p className="whitespace-pre-wrap text-sm text-muted-foreground">{codebase.description}</p></CardContent></Card>}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Timeline</CardTitle></CardHeader>
          <CardContent><dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-muted-foreground">Created</dt><dd className="mt-0.5 font-mono text-xs">{formatDate(codebase.createdAt)}</dd></div>{codebase.updatedAt && <div><dt className="text-xs text-muted-foreground">Updated</dt><dd className="mt-0.5 font-mono text-xs">{formatDate(codebase.updatedAt)}</dd></div>}</dl></CardContent>
        </Card>
      </div>
    </DetailPanel>
  );
}
