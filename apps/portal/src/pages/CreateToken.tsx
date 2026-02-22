// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TokenType, TokenValidationResult, CreateTokenRequest } from "@/types";
import { TOKEN_TYPE_LABELS, TOKEN_CAPABILITY_LABELS } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Alert, AlertDescription, AlertTitle,
} from "@/components/ui/alert";
import { ArrowLeft, ArrowRight, Loader2, CheckCircle2, XCircle, AlertTriangle, ExternalLink } from "lucide-react";
import { toast } from "sonner";

const TOKEN_INSTRUCTIONS: Record<TokenType, { steps: string[]; link?: { label: string; url: string }; note?: string }> = {
  "github-pat-classic": {
    steps: [
      "Go to GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)",
      "Click 'Generate new token (classic)'",
      "Select scopes: 'copilot' (for Copilot SDK/CLI/VS Code) and/or 'repo' as needed",
      "Set an expiration and click 'Generate token'",
      "Copy the token (starts with ghp_)",
    ],
    link: { label: "Open GitHub token settings", url: "https://github.com/settings/tokens" },
    note: "Classic PATs cannot access GitHub Models. Use a fine-grained PAT with models:read for that.",
  },
  "github-pat-fine-grained": {
    steps: [
      "Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens",
      "Click 'Generate new token'",
      "Set a token name, expiration, and resource owner",
      "Under Permissions, add 'Models' → Read access (for GitHub Models)",
      "Click 'Generate token'",
      "Copy the token (starts with github_pat_)",
    ],
    link: { label: "Open GitHub token settings", url: "https://github.com/settings/personal-access-tokens" },
    note: "Fine-grained PATs support GitHub Models via the models:read permission. They do not support Copilot SDK.",
  },
  "github-oauth": {
    steps: [
      "Obtain a GitHub OAuth token via an OAuth App flow (authorization code grant)",
      "The token should have the 'copilot' scope for Copilot capabilities",
      "Copy the OAuth access token",
    ],
    note: "OAuth tokens typically support all GitHub capabilities including Copilot SDK, CLI, VS Code, and GitHub Models.",
  },
  "github-oauth-cookie-state": {
    steps: [
      "Open VS Code for the Web (vscode.dev) and sign in with GitHub",
      "Open browser DevTools → Application → Cookies",
      "Find the GitHub auth cookies and export them as a JSON object",
      "Paste the full JSON blob below",
    ],
    note: "This cookie state is used by the VS Code Web worker to authenticate as a signed-in user.",
  },
  "anthropic-api-key": {
    steps: [
      "Go to the Anthropic Console → API Keys",
      "Click 'Create Key'",
      "Name the key and click 'Create'",
      "Copy the API key (starts with sk-ant-)",
    ],
    link: { label: "Open Anthropic Console", url: "https://console.anthropic.com/settings/keys" },
  },
};

const TOKEN_TYPES: TokenType[] = [
  "github-pat-classic",
  "github-pat-fine-grained",
  "github-oauth",
  "github-oauth-cookie-state",
  "anthropic-api-key",
];

/** Expected prefix per token type for surface-level validation. */
const TOKEN_PREFIXES: Record<TokenType, { prefix: string; description: string }> = {
  "github-pat-classic": { prefix: "ghp_", description: "ghp_" },
  "github-pat-fine-grained": { prefix: "github_pat_", description: "github_pat_" },
  "github-oauth": { prefix: "gho_", description: "gho_ or ghu_" }, // also ghu_ for user tokens
  "github-oauth-cookie-state": { prefix: "{", description: "JSON object" },
  "anthropic-api-key": { prefix: "sk-ant-", description: "sk-ant-" },
};

/** Check if the token value matches the expected prefix for the selected type. */
function validateTokenPrefix(tokenType: TokenType, tokenValue: string): string | null {
  const trimmed = tokenValue.trim();
  if (!trimmed) return null; // Don't warn on empty input

  const expected = TOKEN_PREFIXES[tokenType];

  // Special case: github-oauth can start with gho_ or ghu_
  if (tokenType === "github-oauth") {
    if (trimmed.startsWith("gho_") || trimmed.startsWith("ghu_")) return null;
    return `Expected prefix: ${expected.description}`;
  }

  if (!trimmed.startsWith(expected.prefix)) {
    return `Expected prefix: ${expected.description}`;
  }

  return null; // Valid prefix
}

type Step = "input" | "review";

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "valid":
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    case "invalid":
    case "expired":
      return <XCircle className="h-5 w-5 text-destructive" />;
    default:
      return <AlertTriangle className="h-5 w-5 text-yellow-500" />;
  }
}

export function CreateToken() {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>("input");
  const [type, setType] = useState<TokenType>("github-pat-classic");
  const [value, setValue] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [comment, setComment] = useState("");
  const [previewResult, setPreviewResult] = useState<TokenValidationResult | null>(null);

  const previewMutation = useMutation({
    mutationFn: () => api.previewToken({ type, value: value.trim() }),
    onSuccess: (result) => {
      setPreviewResult(result);
      setStep("review");
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const createMutation = useMutation({
    mutationFn: (body: CreateTokenRequest) => api.createToken(body),
    onSuccess: (data) => {
      toast.success("Token registered successfully");
      navigate(`/tokens/${data._id}`);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const handleValidate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) {
      toast.error("Token value is required");
      return;
    }
    const prefixError = validateTokenPrefix(type, value);
    if (prefixError) {
      toast.error(`Invalid token format: ${prefixError}`);
      return;
    }
    previewMutation.mutate();
  };

  const handleRegister = () => {
    createMutation.mutate({
      type,
      value: value.trim(),
      expiresAt: expiresAt || undefined,
      comment: comment.trim() || undefined,
    });
  };

  const handleBack = () => {
    setStep("input");
    setPreviewResult(null);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Back link */}
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/tokens")}>
        <ArrowLeft className="h-4 w-4" /> Back to Tokens
      </Button>

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className={step === "input" ? "font-semibold text-foreground" : ""}>1. Enter Token</span>
        <ArrowRight className="h-3 w-3" />
        <span className={step === "review" ? "font-semibold text-foreground" : ""}>2. Review & Register</span>
      </div>

      {step === "input" && (
        <Card>
          <CardHeader>
            <CardTitle>Enter Token Details</CardTitle>
            <CardDescription>
              Provide the token type and value. We'll validate it and show detected capabilities before registration.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleValidate} className="space-y-4">
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
                  The credential format. Capabilities are detected automatically during validation.
                </p>
              </div>

              {/* Instructions */}
              {(() => {
                const info = TOKEN_INSTRUCTIONS[type];
                return (
                  <div className="rounded-md border bg-muted/50 p-4 space-y-3">
                    <p className="text-sm font-medium">How to create this token</p>
                    <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                      {info.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                    {info.link && (
                      <a
                        href={info.link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {info.link.label}
                      </a>
                    )}
                    {info.note && (
                      <p className="text-xs text-muted-foreground italic">{info.note}</p>
                    )}
                  </div>
                );
              })()}

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
                  Will be stored securely in KeyVault. Cannot be retrieved after creation.
                </p>
                {/* Prefix validation warning */}
                {(() => {
                  const warning = validateTokenPrefix(type, value);
                  if (!warning) return null;
                  return (
                    <p className="flex items-center gap-1.5 text-xs text-amber-600">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      Token format doesn't match selected type. {warning}
                    </p>
                  );
                })()}
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

              {/* Comment */}
              <div className="space-y-2">
                <Label htmlFor="comment">Comment (optional)</Label>
                <Input
                  id="comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="e.g. John's CI token"
                  maxLength={500}
                />
                <p className="text-xs text-muted-foreground">
                  A short note to help identify this token later.
                </p>
              </div>

              {/* Validate */}
              <Button
                type="submit"
                disabled={previewMutation.isPending || !value.trim() || !!validateTokenPrefix(type, value)}
                className="gap-1.5"
              >
                {previewMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Validate & Preview
                <ArrowRight className="h-4 w-4" />
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {step === "review" && previewResult && (
        <Card>
          <CardHeader>
            <CardTitle>Review Detected Capabilities</CardTitle>
            <CardDescription>
              Verify the validation results below before registering the token.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Validation status */}
            <div className="flex items-center gap-3">
              <StatusIcon status={previewResult.status} />
              <div>
                <p className="font-medium capitalize">
                  Validation: {previewResult.status}
                </p>
                {previewResult.error && (
                  <p className="text-sm text-destructive">{previewResult.error}</p>
                )}
              </div>
            </div>

            {previewResult.status !== "valid" && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Validation failed</AlertTitle>
                <AlertDescription>
                  You can still register this token, but it won't be usable until validation passes.
                </AlertDescription>
              </Alert>
            )}

            <Separator />

            {/* Token type */}
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Token Type</p>
              <p>{TOKEN_TYPE_LABELS[type]}</p>
            </div>

            {/* Capabilities */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Detected Capabilities</p>
              {(previewResult.capabilities ?? []).length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {previewResult.capabilities!.map((c) => (
                    <Badge key={c} variant="secondary" className="text-sm">
                      {TOKEN_CAPABILITY_LABELS[c] ?? c}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No capabilities detected</p>
              )}
            </div>

            {/* Scopes (if present) */}
            {previewResult.scopes && previewResult.scopes.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">OAuth Scopes</p>
                <div className="flex flex-wrap gap-1.5">
                  {previewResult.scopes.map((s) => (
                    <Badge key={s} variant="outline" className="text-xs font-mono">
                      {s}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Rate limit (if present) */}
            {previewResult.rateLimit && (
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Rate Limit</p>
                <p className="text-sm">
                  {previewResult.rateLimit.remaining.toLocaleString()} / {previewResult.rateLimit.limit.toLocaleString()} remaining
                </p>
              </div>
            )}

            {/* Expiry */}
            {expiresAt && (
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Expires At</p>
                <p className="text-sm">{new Date(expiresAt).toLocaleString()}</p>
              </div>
            )}

            <Separator />

            {/* Actions */}
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={handleBack} disabled={createMutation.isPending}>
                <ArrowLeft className="h-4 w-4 mr-1.5" />
                Back
              </Button>
              <Button onClick={handleRegister} disabled={createMutation.isPending} className="gap-1.5">
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Register Token
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
