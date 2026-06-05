// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { ProfileCreateForm } from "@/components/ProfileCreateForm";

export function CreateProfile() {
  const navigate = useNavigate();

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/profiles")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Create Profile</h1>
          <p className="text-muted-foreground">
            Save a reusable run configuration for reproducible benchmarking.
          </p>
        </div>
      </div>
      <ProfileCreateForm
        onCancel={() => navigate("/profiles")}
        onCreated={(profile) => navigate(`/profiles/${profile.id}`)}
      />
    </div>
  );
}
