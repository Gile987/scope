// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CodebaseRevisionDocument } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Trash2, RefreshCw, Loader2, FolderGit2, GitCommit, Upload, FileArchive, ExternalLink } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function CodebaseDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [refDialogOpen, setRefDialogOpen] = useState(false);
  const [requestedRef, setRequestedRef] = useState("");

  const { data: codebase, isLoading, error } = useQuery({
    queryKey: ["codebase", id],
    queryFn: () => api.getCodebase(id!),
    enabled: !!id,
  });

  const { data: revisions = [], isLoading: loadingRevisions } = useQuery({
    queryKey: ["codebase-revisions", id],
    queryFn: () => api.listCodebaseRevisions(id!, 50),
    enabled: !!id,
  });

  const latestRevision = revisions[0] ?? null;

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteCodebase(id!),
    onSuccess: () => {
      toast.success("Codebase deleted");
      navigate("/codebases");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to delete codebase"),
  });

  const resolveMutation = useMutation({
    mutationFn: (ref?: string) => api.resolveCodebaseRevision(id!, ref),
    onSuccess: (revision) => {
      queryClient.invalidateQueries({ queryKey: ["codebase", id] });
      queryClient.invalidateQueries({ queryKey: ["codebase-revisions", id] });
      toast.success(`Resolved ${revision.ref}`);
      setRefDialogOpen(false);
      setRequestedRef("");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to resolve codebase"),
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadCodebaseArchive(id!, file),
    onSuccess: (revision) => {
      queryClient.invalidateQueries({ queryKey: ["codebase", id] });
      queryClient.invalidateQueries({ queryKey: ["codebase-revisions", id] });
      toast.success(`Uploaded ${revision.ref}`);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to upload archive"),
  });

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  if (error || !codebase) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/codebases")}><ArrowLeft className="h-4 w-4" /> Back to Codebases</Button>
        <div className="py-12 text-center text-muted-foreground">Codebase not found</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/codebases")}><ArrowLeft className="h-4 w-4" /> Back to Codebases</Button>

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <FolderGit2 className="h-6 w-6" />
            <h1 className="text-2xl font-bold tracking-tight">{codebase.name}</h1>
            <Badge variant="outline" className="text-xs">{codebase.sourceType}</Badge>
          </div>
          <div className="mt-1 flex items-center gap-3">
            <p className="font-mono text-sm text-muted-foreground">{codebase.slug}</p>
            {codebase.source && (
              <a href={`https://github.com/${codebase.source}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                <ExternalLink className="h-3 w-3" /> GitHub
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {codebase.sourceType === "git" ? (
            <>
              <Button onClick={() => resolveMutation.mutate(undefined)} disabled={resolveMutation.isPending} variant="outline" className="gap-1.5">
                {resolveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Resolve latest
              </Button>
              <Button onClick={() => setRefDialogOpen(true)} disabled={resolveMutation.isPending} variant="outline" className="gap-1.5">
                <GitCommit className="h-4 w-4" /> Resolve ref…
              </Button>
            </>
          ) : (
            <>
              <input ref={fileInputRef} type="file" className="hidden" accept=".zip,.tar,.tgz,.tar.gz,.gz" onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadMutation.mutate(file); }} />
              <Button onClick={() => fileInputRef.current?.click()} disabled={uploadMutation.isPending} variant="outline" className="gap-1.5">
                {uploadMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Upload archive
              </Button>
            </>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="destructive" size="icon"><Trash2 className="h-4 w-4" /></Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete codebase?</AlertDialogTitle>
                <AlertDialogDescription>This deletes the codebase &quot;{codebase.name}&quot;. Existing runs keep their resolved revision.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => deleteMutation.mutate()}>Delete</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">Revision history</CardTitle>
            <CardDescription>Immutable snapshots available to seed a run workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            {loadingRevisions ? (
              <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
            ) : revisions.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {codebase.sourceType === "git" ? "No revisions yet. Resolve latest to snapshot the repository." : "No revisions yet. Upload an archive to create the first snapshot."}
              </div>
            ) : (
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Revision</th>
                      <th className="px-3 py-2 text-left font-medium">Requested</th>
                      <th className="px-3 py-2 text-left font-medium">Commit / content</th>
                      <th className="px-3 py-2 text-right font-medium">Files</th>
                      <th className="px-3 py-2 text-right font-medium">Size</th>
                      <th className="px-3 py-2 text-left font-medium">Resolved</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {revisions.map((revision) => <RevisionRow key={revision._id} revision={revision} latest={revision._id === latestRevision?._id} />)}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Details</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Detail label="Source type"><Badge variant="outline" className="text-xs">{codebase.sourceType}</Badge></Detail>
              {codebase.source && <Detail label="Source"><span className="font-mono text-xs">{codebase.source}</span></Detail>}
              {codebase.defaultBranch && <Detail label="Default branch"><span className="font-mono text-xs">{codebase.defaultBranch}</span></Detail>}
              {codebase.description && <Detail label="Description"><span className="text-xs">{codebase.description}</span></Detail>}
              <Detail label="Latest revision"><span className="font-mono text-xs">{latestRevision?.ref ?? "None"}</span></Detail>
              <Detail label="Created"><span className="text-xs text-muted-foreground">{formatDate(codebase.createdAt)}</span></Detail>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Latest provenance</CardTitle>
              <CardDescription className="text-xs">Snapshot metadata used by runs.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {latestRevision ? <RevisionProvenance revision={latestRevision} /> : <p className="py-4 text-center text-xs text-muted-foreground">No revision resolved yet.</p>}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={refDialogOpen} onOpenChange={setRefDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Resolve git ref</DialogTitle></DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="codebase-ref">Branch, tag, or commit SHA</Label>
            <Input id="codebase-ref" value={requestedRef} onChange={(e) => setRequestedRef(e.target.value)} placeholder={codebase.defaultBranch ?? "main"} className="font-mono" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRefDialogOpen(false)}>Cancel</Button>
            <Button disabled={!requestedRef.trim() || resolveMutation.isPending} onClick={() => resolveMutation.mutate(requestedRef.trim())}>
              {resolveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Resolve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RevisionRow({ revision, latest }: { revision: CodebaseRevisionDocument; latest: boolean }) {
  return (
    <tr className={cn(latest && "bg-primary/5")}>
      <td className="px-3 py-2"><span className="font-mono text-xs">{revision.ref}</span>{latest && <Badge variant="secondary" className="ml-2 text-[10px]">latest</Badge>}</td>
      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{revision.requestedRef ?? revision.ref}</td>
      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{shortSha(revision.resolvedCommitSha) ?? shortSha(revision.contentSha256) ?? "—"}</td>
      <td className="px-3 py-2 text-right text-xs text-muted-foreground">{revision.fileCount?.toLocaleString() ?? "—"}</td>
      <td className="px-3 py-2 text-right text-xs text-muted-foreground">{formatBytes(revision.sizeBytes)}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(revision.resolvedAt)}</td>
    </tr>
  );
}

function RevisionProvenance({ revision }: { revision: CodebaseRevisionDocument }) {
  return (
    <div className="space-y-2">
      <Detail label="Revision"><span className="font-mono text-xs">{revision.ref}</span></Detail>
      <Detail label="Source"><span className="font-mono text-xs">{revision.source ?? revision.sourceType}</span></Detail>
      {revision.requestedRef && <Detail label="Requested ref"><span className="font-mono text-xs">{revision.requestedRef}</span></Detail>}
      {revision.resolvedCommitSha && <Detail label="Commit"><span className="font-mono text-xs">{shortSha(revision.resolvedCommitSha)}</span></Detail>}
      {revision.contentSha256 && <Detail label="Content SHA"><span className="font-mono text-xs">{shortSha(revision.contentSha256)}</span></Detail>}
      {revision.originalFilename && <Detail label="Archive"><span className="inline-flex items-center gap-1 font-mono text-xs"><FileArchive className="h-3 w-3" />{revision.originalFilename}</span></Detail>}
      <Detail label="Files"><span className="text-xs">{revision.fileCount?.toLocaleString() ?? "—"}</span></Detail>
      <Detail label="Size"><span className="text-xs">{formatBytes(revision.sizeBytes)}</span></Detail>
      <Detail label="Resolved"><span className="text-xs text-muted-foreground">{formatDate(revision.resolvedAt)}</span></Detail>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><span className="text-xs text-muted-foreground">{label}</span><div className="break-all">{children}</div></div>;
}

function shortSha(value?: string): string | undefined {
  return value ? value.slice(0, 12) : undefined;
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
