// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CodebaseDocument, CodebaseRevisionDocument, CodebaseSourceType } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { GitBranch, Loader2, Package, Plus, UploadCloud, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MAX_ARCHIVE_UPLOAD_LABEL, formatBytes, validateArchiveFile } from "@/lib/codebaseUpload";

/** A created codebase, optionally bundled with its first revision (archive). */
export type CreatedCodebase = CodebaseDocument & { firstRevision?: CodebaseRevisionDocument };

interface CodebaseCreateFormProps {
  onCreated?: (codebase: CreatedCodebase) => void;
  onCancel?: () => void;
  className?: string;
  compact?: boolean;
}

export function CodebaseCreateForm({ onCreated, onCancel, className, compact = false }: CodebaseCreateFormProps) {
  const queryClient = useQueryClient();
  const [sourceType, setSourceType] = useState<CodebaseSourceType>("git");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [source, setSource] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [description, setDescription] = useState("");
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Slug/name are mutually auto-generated: typing in one populates the other
  // until that other field has been manually edited, at which point they
  // decouple. slugify("My Repo") -> "my-repo"; humanize("my-repo") -> "My Repo".
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const humanize = (s: string) =>
    s.replace(/-+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());

  const handleNameChange = (value: string) => {
    setName(value);
    setNameEdited(value.trim().length > 0);
    if (!slugEdited) setSlug(slugify(value));
  };

  const handleSlugChange = (value: string) => {
    // Keep slug input within the allowed charset but permit a trailing dash
    // while the user is still typing.
    const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-");
    setSlug(normalized);
    setSlugEdited(normalized.trim().length > 0);
    if (!nameEdited) setName(humanize(normalized));
  };

  // For git codebases the repository is entered first, so seed the not-yet-edited
  // name/slug from the repo name (the part after "owner/"): "pamelafox/pamelafox-site"
  // -> name "pamelafox-site", slug "pamelafox-site".
  const handleSourceChange = (value: string) => {
    setSource(value);
    const repoName = value.split("/").pop()?.trim() ?? "";
    if (repoName) {
      if (!nameEdited) setName(repoName);
      if (!slugEdited) setSlug(slugify(repoName));
    }
  };

  const acceptFile = (file: File | null | undefined) => {
    if (!file) return;
    const error = validateArchiveFile(file);
    if (error) {
      toast.error(error);
      return;
    }
    setArchiveFile(file);
  };

  const resetFields = () => {
    setName("");
    setSlug("");
    setNameEdited(false);
    setSlugEdited(false);
    setSource("");
    setDefaultBranch("");
    setDescription("");
    setArchiveFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const createMutation = useMutation({
    mutationFn: () => {
      if (sourceType === "archive") {
        if (!archiveFile) throw new Error("An archive file is required for archive codebases");
        return api.createArchiveCodebase(
          {
            name: name.trim(),
            ...(slug.trim() ? { slug: slug.trim() } : {}),
            ...(description.trim() ? { description: description.trim() } : {}),
          },
          archiveFile,
        );
      }
      return api.createCodebase({
        name: name.trim(),
        sourceType,
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(source.trim() ? { source: source.trim() } : {}),
        ...(defaultBranch.trim() ? { defaultBranch: defaultBranch.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["codebases"] });
      toast.success(`Codebase "${created.slug}" created`);
      onCreated?.(created);
      resetFields();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to create codebase"),
  });

  const sourceValid = sourceType === "archive" || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.trim());
  const archiveValid = sourceType !== "archive" || archiveFile !== null;
  const canCreate = name.trim().length > 0 && sourceValid && archiveValid && !createMutation.isPending;

  return (
    <div className={cn("space-y-4", className)}>
      <div className="space-y-2">
        <Label>Source type</Label>
        <div className="grid grid-cols-2 gap-2">
          {([
            { value: "git" as const, label: "Git repository", icon: GitBranch, hint: "Snapshot a GitHub repo" },
            { value: "archive" as const, label: "Uploaded archive", icon: Package, hint: "Upload a tar/zip" },
          ]).map((opt) => {
            const Icon = opt.icon;
            const active = sourceType === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setSourceType(opt.value)}
                aria-pressed={active}
                className={cn(
                  "flex items-start gap-2 rounded-md border p-3 text-left transition-colors",
                  active
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-input hover:border-foreground/30 hover:bg-muted/50",
                )}
              >
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium leading-tight">{opt.label}</span>
                  <span className="block text-xs text-muted-foreground">{opt.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {sourceType === "git" && (
        <div className={cn("grid gap-4", compact ? "grid-cols-1" : "sm:grid-cols-2")}>
          <div className="space-y-2">
            <Label htmlFor="codebase-source">GitHub repository *</Label>
            <Input id="codebase-source" value={source} onChange={(e) => handleSourceChange(e.target.value)} placeholder="owner/repo" className="font-mono" />
            {!sourceValid && source.trim() && <p className="text-xs text-destructive">Use owner/repo format.</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="codebase-default-branch">Default branch</Label>
            <Input id="codebase-default-branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} placeholder="main" className="font-mono" />
          </div>
        </div>
      )}

      <div className={cn("grid gap-4", compact ? "grid-cols-1" : "sm:grid-cols-2")}>
        <div className="space-y-2">
          <Label htmlFor="codebase-name">Name *</Label>
          <Input id="codebase-name" value={name} onChange={(e) => handleNameChange(e.target.value)} placeholder="scope-core" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="codebase-slug">Slug</Label>
          <Input id="codebase-slug" value={slug} onChange={(e) => handleSlugChange(e.target.value)} placeholder="auto-generated" className="font-mono" />
        </div>
      </div>

      {sourceType === "archive" && (
        <div className="space-y-2">
          <Label htmlFor="codebase-archive">Archive *</Label>
          <input
            ref={fileInputRef}
            id="codebase-archive"
            type="file"
            className="sr-only"
            accept=".tar.gz,.tgz,.tar,.zip,application/gzip,application/x-gzip,application/zip,application/x-tar"
            onChange={(e) => acceptFile(e.target.files?.[0])}
          />
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragActive(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              acceptFile(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-6 text-center transition-colors",
              dragActive
                ? "border-primary bg-primary/10"
                : archiveFile
                  ? "border-primary/40 bg-primary/5"
                  : "border-input hover:border-foreground/40 hover:bg-muted/50",
            )}
          >
            {archiveFile ? (
              <>
                <Package className="h-6 w-6 text-primary" />
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{archiveFile.name}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setArchiveFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Remove file"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <span className="text-xs text-muted-foreground">{formatBytes(archiveFile.size)} · click or drop to replace</span>
              </>
            ) : (
              <>
                <UploadCloud className={cn("h-6 w-6", dragActive ? "text-primary" : "text-muted-foreground")} />
                <span className="text-sm font-medium">
                  Drag &amp; drop an archive here, or <span className="text-primary underline">browse</span>
                </span>
                <span className="text-xs text-muted-foreground">.tar.gz, .tgz, .tar, or .zip · up to {MAX_ARCHIVE_UPLOAD_LABEL} — becomes the first revision</span>
              </>
            )}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="codebase-description">Description</Label>
        <Textarea id="codebase-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={compact ? 2 : 3} placeholder="What this workspace seed contains" />
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
        <Button type="button" size="sm" className="gap-1.5" disabled={!canCreate} onClick={() => createMutation.mutate()}>
          {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Create codebase
        </Button>
      </div>
    </div>
  );
}
