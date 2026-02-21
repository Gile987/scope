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
import { ArrowLeft, ArrowRight, Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

const TOKEN_TYPES: TokenType[] = [
  "github-pat-classic",
  "github-pat-fine-grained",
  "github-oauth",
  "github-oauth-cookie-state",
  "anthropic-api-key",
];

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
    previewMutation.mutate();
  };

  const handleRegister = () => {
    createMutation.mutate({
      type,
      value: value.trim(),
      expiresAt: expiresAt || undefined,
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

              {/* Validate */}
              <Button type="submit" disabled={previewMutation.isPending} className="gap-1.5">
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
