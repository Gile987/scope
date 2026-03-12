// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ACCOUNT_TYPE_LABELS } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Pencil, Trash2, Save, X } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";

export function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [editComment, setEditComment] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);

  const { data: account, isLoading } = useQuery({
    queryKey: ["accounts", id],
    queryFn: () => api.getAccount(id!),
    enabled: !!id,
  });

  const updateMutation = useMutation({
    mutationFn: (body: Parameters<typeof api.updateAccount>[1]) => api.updateAccount(id!, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts", id] });
      setEditing(false);
      toast.success("Account updated");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteAccount(id!),
    onSuccess: () => {
      toast.success("Account deleted");
      navigate("/secrets/accounts");
    },
  });

  function startEditing() {
    if (!account) return;
    setEditComment(account.comment ?? "");
    setEditEnabled(account.enabled);
    setEditing(true);
  }

  function saveEdit() {
    updateMutation.mutate({
      enabled: editEnabled,
      comment: editComment.trim() || null,
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-2xl">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/secrets/accounts")}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <p className="text-muted-foreground">Account not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/secrets/accounts")}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-bold tracking-tight">Account Detail</h1>
          <p className="font-mono text-sm text-muted-foreground">{account._id}</p>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm" className="gap-1.5">
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete account?</AlertDialogTitle>
              <AlertDialogDescription>
                This soft-deletes the account. The KeyVault secret is preserved.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => deleteMutation.mutate()}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Metadata card */}
      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Type</span>
            <div>
              <Badge variant="outline">{ACCOUNT_TYPE_LABELS[account.type]}</Badge>
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Secret Name</span>
            <div className="font-mono text-xs">{account.secretName}</div>
          </div>
          <div>
            <span className="text-muted-foreground">Created</span>
            <div>{formatDate(account.createdAt)}</div>
          </div>
          <div>
            <span className="text-muted-foreground">Updated</span>
            <div>{account.updatedAt ? formatDate(account.updatedAt) : "—"}</div>
          </div>
        </CardContent>
      </Card>

      {/* Editable card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Settings</CardTitle>
          {!editing ? (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={startEditing}>
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setEditing(false)}>
                <X className="h-4 w-4" /> Cancel
              </Button>
              <Button size="sm" className="gap-1.5" onClick={saveEdit} disabled={updateMutation.isPending}>
                <Save className="h-4 w-4" /> Save
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Enabled</Label>
            {editing ? (
              <Switch checked={editEnabled} onCheckedChange={setEditEnabled} />
            ) : (
              <Badge variant={account.enabled ? "default" : "secondary"}>
                {account.enabled ? "Yes" : "No"}
              </Badge>
            )}
          </div>
          <div className="space-y-1">
            <Label>Comment</Label>
            {editing ? (
              <Input
                value={editComment}
                onChange={(e) => setEditComment(e.target.value)}
                placeholder="Optional annotation"
              />
            ) : (
              <p className="text-sm">{account.comment || <span className="text-muted-foreground">—</span>}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
