// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useNavigate, useSearchParams } from "react-router-dom";
import { PromptFeatureWizard } from "@/components/PromptFeatureWizard";

export function CreatePromptFeature() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const initialBehavior = searchParams.get("behavior") ?? "";
  const initialId = searchParams.get("id") ?? "";
  const initialPrompt = searchParams.get("prompt") ?? "";

  return (
    <div className="max-w-2xl mx-auto">
      <PromptFeatureWizard
        initialBehavior={initialBehavior}
        initialId={initialId}
        initialPrompt={initialPrompt}
        onCreated={(feature) => navigate(`/prompt-features/${feature.id}`)}
        onCancel={() => navigate("/prompt-features")}
      />
    </div>
  );
}

