// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TokenType, CreateTokenRequest } from "@/types";
import { TOKEN_TYPE_LABELS } from "@/types";
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
  "github-pat-classic",
  "github-pat-fine-grained",
  "github-oauth",
  "github-oauth-cookie-state",
  "anthropic-api-key",
];

export function CreateToken() {
  const navigate = useNavigate();

  const [type, setType] = useState<TokenType>("github-pat-classic");
  const [value, setValue] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  const createMutation = useMutation({
    mutationFn: (body: CreateTokenRequest) => api.createToken(body),
    onSuccess: (data) => {
      toast.success("Token registered — capabilities will be detected after validation");
      navigate(`/tokens/${data._id}`);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) {
      toast.error("Token value is required");
      return;
    }
    createMutation.mutate({
      type,
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
            Add a new API token. Capabilities are auto-detected based on the token type and its permissions.
            The secret value is stored in KeyVault and never returned after creation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Type */}
            <div className="space-y-2">
              <Label htmlFor="type">Token Type</Label>
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
              <p className="text-xs text-muted-foreground">
                The credential format. Capabilities are detected automatically after validation.
              </p>
            </div>

            {/* Value */}
            <div className="space-y-2">
              <Label htmlFor="value">Token Value</Label>
              {type === "github-oauth-cookie-state" ? (
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
