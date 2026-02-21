// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TokenType, TokenUsage, CreateTokenRequest } from "@/types";
import { TOKEN_TYPE_LABELS, TOKEN_USAGE_LABELS } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

const TOKEN_TYPES: TokenType[] = [
  "github-pat",
  "anthropic-api-key",
  "github-models-api-key",
  "github-oauth-state",
];

const TOKEN_USAGES: TokenUsage[] = [
  "copilot",
  "claude-code",
  "github-models",
  "vscode-web",
];

/** Suggest a default type based on the chosen usage */
function suggestType(usage: TokenUsage): TokenType {
  switch (usage) {
    case "copilot": return "github-pat";
    case "claude-code": return "anthropic-api-key";
    case "github-models": return "github-models-api-key";
    case "vscode-web": return "github-oauth-state";
  }
}

export function CreateToken() {
  const navigate = useNavigate();

  const [usage, setUsage] = useState<TokenUsage>("copilot");
  const [type, setType] = useState<TokenType>("github-pat");
  const [value, setValue] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  const createMutation = useMutation({
    mutationFn: (body: CreateTokenRequest) => api.createToken(body),
    onSuccess: (data) => {
      toast.success("Token registered");
      navigate(`/tokens/${data._id}`);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const handleUsageChange = (u: string) => {
    const usage = u as TokenUsage;
    setUsage(usage);
    setType(suggestType(usage));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) {
      toast.error("Token value is required");
      return;
    }
    createMutation.mutate({
      type,
      usage,
      value: value.trim(),
      expiresAt: expiresAt || undefined,
    });
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Back link */}
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/tokens")}>
        <ArrowLeft className="h-4 w-4" /> Back to Tokens
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>Register Token</CardTitle>
          <CardDescription>
            Add a new API token. The secret value is stored in KeyVault and never returned after creation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Usage */}
            <div className="space-y-2">
              <Label htmlFor="usage">Usage</Label>
              <Select value={usage} onValueChange={handleUsageChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOKEN_USAGES.map((u) => (
                    <SelectItem key={u} value={u}>{TOKEN_USAGE_LABELS[u]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Which worker or service will consume this token
              </p>
            </div>

            {/* Type */}
            <div className="space-y-2">
              <Label htmlFor="type">Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as TokenType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TOKEN_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{TOKEN_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Value */}
            <div className="space-y-2">
              <Label htmlFor="value">Token Value</Label>
              {type === "github-oauth-state" ? (
                <Textarea
                  id="value"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Paste JSON auth state blob…"
                  rows={6}
                  className="font-mono text-xs"
                />
              ) : (
                <Input
                  id="value"
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Paste token or API key…"
                />
              )}
              <p className="text-xs text-muted-foreground">
                Stored securely in KeyVault. Cannot be retrieved after creation.
              </p>
            </div>

            {/* Expires At */}
            <div className="space-y-2">
              <Label htmlFor="expiresAt">Expires At (optional)</Label>
              <Input
                id="expiresAt"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>

            {/* Submit */}
            <Button type="submit" disabled={createMutation.isPending} className="gap-1.5">
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Register Token
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
