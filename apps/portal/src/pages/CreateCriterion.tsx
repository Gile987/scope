// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useNavigate, useSearchParams } from "react-router-dom";
import { useCriteriaWizard } from "@/hooks/useCriteriaWizard";
import { CriteriaWizardStep1 } from "@/components/CriteriaWizardStep1";
import { CriteriaWizardStep2 } from "@/components/CriteriaWizardStep2";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Stepper } from "@/components/Stepper";
import { ArrowLeft, ArrowRight, Loader2, Sparkles } from "lucide-react";
import { useCommandEnter } from "@/hooks/useCommandEnter";
import { KbdBadge } from "@/components/KbdBadge";

const STEPS = ["Define Criteria", "Review & Create"];

export function CreateCriterion() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const parentParam = searchParams.get("parent");

  const wizard = useCriteriaWizard({
    initialDependsOn: parentParam ? [parentParam] : [],
    onSuccess: (id) => navigate(`/criteria/${id}`),
  });

  // Cmd+Enter / Ctrl+Enter shortcut for primary action
  useCommandEnter(
    wizard.step === 1 ? wizard.handleContinue : wizard.handleCreate,
    wizard.step === 1
      ? wizard.canContinue
      : !!wizard.prompt.trim() && !wizard.createMutation.isPending,
  );

  return (
    <div className="max-w-2xl">
      {wizard.step === 1 ? (
        /* ───────────────────── Step 1: Define Criteria ───────────────────── */
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted">
                <Sparkles className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-semibold">Define Criteria</h1>
                <p className="text-sm text-muted-foreground">
                  Describe the behavior to evaluate
                </p>
              </div>
            </div>
            <Stepper steps={STEPS} currentStep={1} />
          </div>

          <Card>
            <CardContent className="pt-6">
              <CriteriaWizardStep1 wizard={wizard} idPrefix="page-" />
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => navigate("/criteria")}>
              Cancel
            </Button>
            <Button
              onClick={wizard.handleContinue}
              disabled={!wizard.canContinue}
              className="gap-1.5"
            >
              Continue
              <ArrowRight className="h-4 w-4" />
              <KbdBadge />
            </Button>
          </div>
        </div>
      ) : (
        /* ───────────────────── Step 2: Review & Create ───────────────────── */
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted">
                <Sparkles className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-semibold">Review & Create</h1>
                <p className="text-sm text-muted-foreground">
                  Confirm your criteria settings
                </p>
              </div>
            </div>
            <Stepper steps={STEPS} currentStep={2} />
          </div>

          <Card>
            <CardContent className="pt-6">
              <CriteriaWizardStep2 wizard={wizard} />
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              onClick={() => wizard.setStep(1)}
              className="gap-1.5"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            <Button
              onClick={wizard.handleCreate}
              disabled={!wizard.prompt.trim() || wizard.createMutation.isPending}
              className="gap-1.5"
            >
              {wizard.createMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Create Criteria
              <KbdBadge />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
