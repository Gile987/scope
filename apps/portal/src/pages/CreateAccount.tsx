// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import jsQR from "jsqr";
import { api } from "@/lib/api";
import type { AccountType, CreateAccountRequest } from "@/types";
import { ACCOUNT_TYPE_LABELS } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Loader2, Upload, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

const ACCOUNT_TYPES: AccountType[] = ["github"];

export function CreateAccount() {
  const navigate = useNavigate();
  const [type, setType] = useState<AccountType>("github");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState("");
  const [comment, setComment] = useState("");
  const [qrDecoding, setQrDecoding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const canSubmit = username.trim() && password.trim() && totpUri.trim();

  function handleQrUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setQrDecoding(true);
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          toast.error("Could not create canvas context");
          setQrDecoding(false);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code?.data) {
          setTotpUri(code.data);
          toast.success("QR code decoded successfully");
        } else {
          toast.error("Could not decode QR code from image");
        }
        setQrDecoding(false);
      };
      img.onerror = () => {
        toast.error("Could not load image");
        setQrDecoding(false);
      };
      img.src = reader.result as string;
    };
    reader.onerror = () => {
      toast.error("Could not read file");
      setQrDecoding(false);
    };
    reader.readAsDataURL(file);
    // Reset so the same file can be re-selected
    e.target.value = "";
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    createMutation.mutate({
      type,
      username: username.trim(),
      password: password.trim(),
      totpUri: totpUri.trim(),
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
              <SecretInput
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Account password"
                autoComplete="new-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="totpUri">TOTP URI</Label>
              <div className="flex gap-2">
                <SecretInput
                  id="totpUri"
                  value={totpUri}
                  onChange={(e) => setTotpUri(e.target.value)}
                  placeholder="otpauth://totp/... or base32 secret"
                  autoComplete="off"
                  containerClassName="flex-1"
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleQrUpload}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={qrDecoding}
                  onClick={() => fileInputRef.current?.click()}
                  className="gap-1.5 shrink-0"
                >
                  {qrDecoding ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : totpUri ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  QR Code
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Paste an otpauth:// URI, a bare base32 secret, or upload a QR code image.
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
