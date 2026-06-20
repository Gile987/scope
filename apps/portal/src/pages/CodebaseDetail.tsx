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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, Trash2, RefreshCw, Loader2, FolderGit2, GitCommit, Upload,
  FileArchive, ExternalLink, Download, ChevronRight, ChevronDown,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function CodebaseDetail() {
  const { id, revisionId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [refDialogOpen, setRefDialogOpen] = useState(false);
  const [requestedRef, setRequestedRef] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

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
  const revisionInList = revisionId ? revisions.find((r) => r._id === revisionId) ?? null : null;

  // Deep links may target a revision outside the fetched window; fetch it on demand.
  const { data: fetchedRevision } = useQuery({
    queryKey: ["codebase-revision", revisionId],
    queryFn: () => api.getCodebaseRevision(revisionId!),
    enabled: !!revisionId && !revisionInList && !loadingRevisions,
  });

  const selectedRevision = revisionId
    ? revisionInList ?? fetchedRevision ?? null
    : latestRevision;

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
      navigate(`/codebases/${id}`);
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
      navigate(`/codebases/${id}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to upload archive"),
  });

  const selectRevision = (revision: CodebaseRevisionDocument) => {
    if (revision._id === latestRevision?._id) navigate(`/codebases/${id}`);
    else navigate(`/codebases/${id}/revisions/${revision._id}`);
  };

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

  const isLatestSelected = !!selectedRevision && selectedRevision._id === latestRevision?._id;

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

      {/* Revision switcher */}
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border bg-card p-3">
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Revision</Label>
            {loadingRevisions ? (
              <Skeleton className="h-10 w-72" />
            ) : revisions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No revisions yet.</p>
            ) : (
              <Select
                value={selectedRevision?._id ?? latestRevision?._id ?? ""}
                onValueChange={(value) => {
                  const next = revisions.find((r) => r._id === value);
                  if (next) selectRevision(next);
                }}
              >
                <SelectTrigger className="w-72 font-mono"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {revisions.map((revision) => (
                    <SelectItem key={revision._id} value={revision._id} className="font-mono">
                      <span className="inline-flex items-center gap-2">
                        {revision.ref}
                        {revision._id === latestRevision?._id && <Badge variant="secondary" className="text-[10px]">latest</Badge>}
                        <span className="text-xs text-muted-foreground">{formatDate(revision.resolvedAt)}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {selectedRevision && !isLatestSelected && (
            <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={() => navigate(`/codebases/${id}`)}>
              <RefreshCw className="h-3.5 w-3.5" /> Jump to latest
            </Button>
          )}
        </div>
        {selectedRevision && (
          <Button asChild variant="outline" className="gap-1.5">
            <a href={`/api/v1/codebase-revisions/${selectedRevision._id}/archive`} download={`${selectedRevision.ref.replace(/[^a-zA-Z0-9_.@-]/g, "_")}.tar.gz`}>
              <Download className="h-4 w-4" /> Download archive
            </a>
          </Button>
        )}
      </div>

      {revisions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {codebase.sourceType === "git" ? "No revisions yet. Resolve latest to snapshot the repository." : "No revisions yet. Upload an archive to create the first snapshot."}
          </CardContent>
        </Card>
      ) : !selectedRevision ? (
        <div className="space-y-2"><Skeleton className="h-48 w-full" /></div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
            <RevisionProvenanceCard revision={selectedRevision} />
            <RevisionSnapshotCard revision={selectedRevision} />
          </div>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Codebase</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Detail label="Source type"><Badge variant="outline" className="text-xs">{codebase.sourceType}</Badge></Detail>
              {codebase.source && <Detail label="Source"><span className="font-mono text-xs">{codebase.source}</span></Detail>}
              {codebase.defaultBranch && <Detail label="Default branch"><span className="font-mono text-xs">{codebase.defaultBranch}</span></Detail>}
              {codebase.description && <Detail label="Description"><span className="text-xs">{codebase.description}</span></Detail>}
              <Detail label="Latest revision"><span className="font-mono text-xs">{latestRevision?.ref ?? "None"}</span></Detail>
              <Detail label="Revisions"><span className="text-xs">{revisions.length}</span></Detail>
              <Detail label="Created"><span className="text-xs text-muted-foreground">{formatDate(codebase.createdAt)}</span></Detail>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Collapsible full history */}
      {revisions.length > 0 && (
        <Card>
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            className="flex w-full items-center gap-2 px-6 py-4 text-left"
          >
            {historyOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <div>
              <CardTitle className="text-base">Revision history</CardTitle>
              <CardDescription>{revisions.length} immutable snapshot{revisions.length === 1 ? "" : "s"} available to seed a run workspace.</CardDescription>
            </div>
          </button>
          {historyOpen && (
            <CardContent>
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
                    {revisions.map((revision) => (
                      <RevisionRow
                        key={revision._id}
                        revision={revision}
                        latest={revision._id === latestRevision?._id}
                        selected={revision._id === selectedRevision?._id}
                        onSelect={() => selectRevision(revision)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          )}
        </Card>
      )}

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

function RevisionRow({ revision, latest, selected, onSelect }: { revision: CodebaseRevisionDocument; latest: boolean; selected: boolean; onSelect: () => void }) {
  return (
    <tr
      className={cn("cursor-pointer hover:bg-muted/50", selected && "bg-primary/5")}
      onClick={onSelect}
    >
      <td className="px-3 py-2"><span className="font-mono text-xs text-primary hover:underline">{revision.ref}</span>{latest && <Badge variant="secondary" className="ml-2 text-[10px]">latest</Badge>}</td>
      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{revision.requestedRef ?? revision.ref}</td>
      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{shortSha(revision.resolvedCommitSha) ?? shortSha(revision.contentSha256) ?? "—"}</td>
      <td className="px-3 py-2 text-right text-xs text-muted-foreground">{revision.fileCount?.toLocaleString() ?? "—"}</td>
      <td className="px-3 py-2 text-right text-xs text-muted-foreground">{formatBytes(revision.sizeBytes)}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground">{formatDate(revision.resolvedAt)}</td>
    </tr>
  );
}

function RevisionProvenanceCard({ revision }: { revision: CodebaseRevisionDocument }) {
  return (
    <Card className="min-w-0">
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
                {shortSha(revision.resolvedCommitSha)} <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <span className="font-mono text-xs">{shortSha(revision.resolvedCommitSha)}</span>
            )}
          </Detail>
        )}
        {revision.commitTimestamp && <Detail label="Commit time"><span className="text-xs text-muted-foreground">{formatDate(revision.commitTimestamp)}</span></Detail>}
        {revision.originalFilename && <Detail label="Original filename"><span className="inline-flex items-center gap-1 font-mono text-xs"><FileArchive className="h-3 w-3" />{revision.originalFilename}</span></Detail>}
        {revision.contentSha256 && <Detail label="Content SHA-256"><span className="break-all font-mono text-xs">{revision.contentSha256}</span></Detail>}
      </CardContent>
    </Card>
  );
}

function RevisionSnapshotCard({ revision }: { revision: CodebaseRevisionDocument }) {
  return (
    <Card className="min-w-0">
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
