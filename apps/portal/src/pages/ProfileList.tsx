// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import type { ProfileWithVersion } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Trash2 } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";

export function ProfileList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: profiles = [], isLoading } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });

  const deleteMutation = useMutation({
    mutationFn: (profileId: string) => api.deleteProfile(profileId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
      toast.success("Profile deleted");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to delete profile");
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Profiles</h1>
          <p className="text-muted-foreground">Saved run configurations for reproducible benchmarking</p>
        </div>
        <Button onClick={() => navigate("/profiles/new")}>
          <Plus className="mr-2 h-4 w-4" /> New Profile
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>MCP Servers</TableHead>
                <TableHead>Skills</TableHead>
                <TableHead>Extensions</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-24" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : profiles.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    No profiles yet. Create one to get started.
                  </TableCell>
                </TableRow>
              ) : (
                profiles.map((profile: ProfileWithVersion) => (
                  <TableRow
                    key={profile._id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/profiles/${profile._id}`)}
                  >
                    <TableCell className="font-medium">{profile.name}</TableCell>
                    <TableCell><Badge variant="secondary">v{profile.version.version}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{profile.version.workerType}</TableCell>
                    <TableCell className="font-mono text-xs">{profile.version.model}</TableCell>
                    <TableCell>{profile.version.mcpServers?.length ?? 0}</TableCell>
                    <TableCell>{profile.version.skillRevisions?.length ?? 0}</TableCell>
                    <TableCell>{profile.version.extensions?.length ?? 0}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {new Date(profile.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete profile?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will soft-delete "{profile.name}". Existing runs referencing this profile will not be affected.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteMutation.mutate(profile._id);
                              }}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
