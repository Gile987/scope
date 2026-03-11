// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { AccountType, CreateAccountRequest } from "@/types";
import { ACCOUNT_TYPE_LABELS } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

const ACCOUNT_TYPES: AccountType[] = ["github"];

export function CreateAccount() {
  const navigate = useNavigate();
  const [type, setType] = useState<AccountType>("github");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpSecret, setTotpSecret] = useState("");
  const [comment, setComment] = useState("");

  const createMutation = useMutation({
    mutationFn: (body: CreateAccountRequest) => api.createAccount(body),
    onSuccess: (data) => {
      toast.success("Account registered");
      navigate(`/secrets/accounts/${data._id}`);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to create account");
    },
  });

  const canSubmit = username.trim() && password.trim() && totpSecret.trim();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    createMutation.mutate({
      type,
      username: username.trim(),
      password: password.trim(),
      totpSecret: totpSecret.trim(),
      comment: comment.trim() || undefined,
    });
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/secrets/accounts")}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Register Account</h1>
          <p className="text-muted-foreground">Store service credentials for key-updater automation</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>Account Details</CardTitle>
            <CardDescription>
              All credential fields are stored encrypted in KeyVault — never in the database.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="type">Account Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as AccountType)}>
                <SelectTrigger id="type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCOUNT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. ci-bot"
                autoComplete="off"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Account password"
                autoComplete="new-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="totpSecret">TOTP Secret</Label>
              <Input
                id="totpSecret"
                type="password"
                value={totpSecret}
                onChange={(e) => setTotpSecret(e.target.value)}
                placeholder="Base32-encoded TOTP secret (from QR code)"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                The base32 secret from your authenticator QR code setup.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="comment">Comment (optional)</Label>
              <Textarea
                id="comment"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="e.g. CI bot account for nightly runs"
                rows={2}
              />
            </div>

            <Button type="submit" disabled={!canSubmit || createMutation.isPending} className="w-full gap-1.5">
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Register Account
            </Button>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
