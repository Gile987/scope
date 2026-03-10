// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { McpTransportType, McpServerHeader } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Trash2, Loader2, Save, Plus } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { useState, useEffect } from "react";

export function McpServerDetail() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: server, isLoading, error } = useQuery({
    queryKey: ["mcp-server", slug],
    queryFn: () => api.getMcpServer(slug!),
    enabled: !!slug,
  });

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<McpTransportType>("http");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [headers, setHeaders] = useState<McpServerHeader[]>([]);

  useEffect(() => {
    if (server) {
      setName(server.name);
      setType(server.type);
      setUrl(server.url);
      setDescription(server.description ?? "");
      setHeaders(server.headers ? [...server.headers] : []);
    }
  }, [server]);

  const updateMutation = useMutation({
    mutationFn: (body: { name?: string; type?: McpTransportType; url?: string; description?: string; headers?: McpServerHeader[] }) =>
      api.updateMcpServer(slug!, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-server", slug] });
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      setEditing(false);
      toast.success("MCP server updated");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to update");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteMcpServer(slug!),
    onSuccess: () => {
      toast.success("MCP server deleted");
      navigate("/mcp-servers");
    },
  });

  const handleSave = () => {
    const filteredHeaders = headers.filter(h => h.name && h.value);
    updateMutation.mutate({
      name,
      type,
      url,
      description: description.trim() || undefined,
      headers: filteredHeaders.length > 0 ? filteredHeaders : undefined,
    });
  };

  const handleCancel = () => {
    setEditing(false);
    if (server) {
      setName(server.name);
      setType(server.type);
      setUrl(server.url);
      setDescription(server.description ?? "");
      setHeaders(server.headers ? [...server.headers] : []);
    }
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

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !server) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/mcp-servers")}>
          <ArrowLeft className="h-4 w-4" /> Back to MCP Servers
        </Button>
        <div className="text-center py-12 text-muted-foreground">
          MCP server not found
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Back link */}
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/mcp-servers")}>
        <ArrowLeft className="h-4 w-4" /> Back to MCP Servers
      </Button>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{server.name}</h1>
          <p className="text-sm text-muted-foreground font-mono">{server._id}</p>
        </div>
        <div className="flex items-center gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="gap-1.5">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete MCP server?</AlertDialogTitle>
                <AlertDialogDescription>
                  This soft-deletes the MCP server &quot;{server.name}&quot;. It will no longer be available for new runs.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => deleteMutation.mutate()}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Server details card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Server Configuration</CardTitle>
            <CardDescription>Connection details for the remote MCP server</CardDescription>
          </div>
          {!editing ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
              <Button size="sm" className="gap-1" onClick={handleSave} disabled={updateMutation.isPending}>
                {updateMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {editing ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-[10rem_1fr] gap-4">
                <div className="space-y-2">
                  <Label htmlFor="type">Transport Type</Label>
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
                  <Label htmlFor="url">URL</Label>
                  <Input
                    id="url"
                    type="url"
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
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                />
              </div>
            </>
          ) : (
            <div className="grid grid-cols-[8rem_1fr] gap-y-3 text-sm">
              <span className="text-muted-foreground">Name</span>
              <span>{server.name}</span>
              <span className="text-muted-foreground">Type</span>
              <Badge variant="outline" className="w-fit uppercase text-xs">{server.type}</Badge>
              <span className="text-muted-foreground">URL</span>
              <span className="font-mono text-xs break-all">{server.url}</span>
              {server.description && (
                <>
                  <span className="text-muted-foreground">Description</span>
                  <span>{server.description}</span>
                </>
              )}
              <span className="text-muted-foreground">Created</span>
              <span className="text-muted-foreground">{formatDate(server.createdAt)}</span>
              {server.updatedAt && (
                <>
                  <span className="text-muted-foreground">Updated</span>
                  <span className="text-muted-foreground">{formatDate(server.updatedAt)}</span>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Headers card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Headers</CardTitle>
            <CardDescription>HTTP headers sent with every request</CardDescription>
          </div>
          {editing && (
            <Button type="button" variant="outline" size="sm" onClick={addHeader} className="gap-1">
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {editing ? (
            headers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No headers configured.</p>
            ) : (
              <div className="space-y-2">
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
              </div>
            )
          ) : (
            (server.headers && server.headers.length > 0) ? (
              <div className="space-y-2">
                {server.headers.map((h, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm">
                    <Badge variant="secondary" className="font-mono text-xs">{h.name}</Badge>
                    <span className="text-muted-foreground font-mono text-xs">
                      {h.name.toLowerCase() === "authorization" ? "••••••••" : h.value}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No headers configured.</p>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
