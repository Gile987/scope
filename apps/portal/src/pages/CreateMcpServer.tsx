// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { McpTransportType, McpServerHeader } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Plus, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";

const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function CreateMcpServer() {
  const navigate = useNavigate();

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<McpTransportType>("http");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [headers, setHeaders] = useState<McpServerHeader[]>([]);

  const createMutation = useMutation({
    mutationFn: api.createMcpServer,
    onSuccess: (data) => {
      toast.success(`MCP server "${data.name}" created`);
      navigate(`/mcp-servers/${data._id}`);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to create MCP server");
    },
  });

  const isValid = slug && SLUG_REGEX.test(slug) && name && url;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    createMutation.mutate({
      _id: slug,
      name,
      type,
      url,
      ...(description ? { description } : {}),
      ...(headers.length > 0 ? { headers: headers.filter(h => h.name && h.value) } : {}),
    });
  };

  const addHeader = () => {
    setHeaders([...headers, { name: "", value: "" }]);
  };

  const updateHeader = (index: number, field: "name" | "value", val: string) => {
    const updated = [...headers];
    updated[index] = { ...updated[index], [field]: val };
    setHeaders(updated);
  };

  const removeHeader = (index: number) => {
    setHeaders(headers.filter((_, i) => i !== index));
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => navigate("/mcp-servers")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Add MCP Server</h1>
          <p className="text-muted-foreground">Register a remote MCP server for use in benchmark runs</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Server Details</CardTitle>
            <CardDescription>Configure the remote MCP server connection</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="slug">Slug (ID) *</Label>
                <Input
                  id="slug"
                  placeholder="e.g., my-search-server"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Lowercase letters, numbers, and hyphens only
                </p>
                {slug && !SLUG_REGEX.test(slug) && (
                  <p className="text-xs text-destructive">
                    Invalid slug format
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  placeholder="e.g., My Search Server"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-[10rem_1fr] gap-4">
              <div className="space-y-2">
                <Label htmlFor="type">Transport Type *</Label>
                <Select value={type} onValueChange={(v) => setType(v as McpTransportType)}>
                  <SelectTrigger id="type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">HTTP (Streamable)</SelectItem>
                    <SelectItem value="sse">SSE</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="url">URL *</Label>
                <Input
                  id="url"
                  type="url"
                  placeholder="https://example.com/mcp"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Optional description of what this MCP server provides"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>
          </CardContent>
        </Card>

        {/* Headers */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Headers</CardTitle>
                <CardDescription>Optional HTTP headers sent with every request (e.g., Authorization)</CardDescription>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addHeader} className="gap-1">
                <Plus className="h-3.5 w-3.5" /> Add Header
              </Button>
            </div>
          </CardHeader>
          {headers.length > 0 && (
            <CardContent className="space-y-3">
              {headers.map((header, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    placeholder="Header name"
                    value={header.name}
                    onChange={(e) => updateHeader(idx, "name", e.target.value)}
                    className="font-mono text-sm"
                  />
                  <Input
                    placeholder="Header value"
                    value={header.value}
                    onChange={(e) => updateHeader(idx, "value", e.target.value)}
                    className="font-mono text-sm"
                  />
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive" onClick={() => removeHeader(idx)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </CardContent>
          )}
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={!isValid || createMutation.isPending} className="gap-1.5">
            {createMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Creating…
              </>
            ) : (
              "Create Server"
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
