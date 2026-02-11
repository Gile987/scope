// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Check } from "lucide-react";

interface StepperProps {
  steps: string[];
  currentStep: number;
}

export function Stepper({ steps, currentStep }: StepperProps) {
  return (
    <div className="flex items-center gap-0">
      {steps.map((label, i) => {
        const stepNum = i + 1;
        const isActive = stepNum === currentStep;
        const isCompleted = stepNum < currentStep;

        return (
          <div key={label} className="flex items-center">
            {/* Connector line (before step, except first) */}
            {i > 0 && (
              <div
                className={`w-8 h-0.5 ${
                  isCompleted || isActive ? "bg-foreground" : "bg-muted-foreground/30"
                }`}
              />
            )}

            {/* Step circle */}
            <div
              className={`
                relative flex items-center justify-center w-8 h-8 rounded-full text-sm font-semibold transition-colors
                ${isCompleted
                  ? "bg-foreground text-background"
                  : isActive
                    ? "bg-foreground text-background"
                    : "border-2 border-muted-foreground/30 text-muted-foreground"
                }
              `}
              title={label}
            >
              {isCompleted ? <Check className="h-4 w-4" /> : stepNum}
            </div>
          </div>
        );
      })}
    </div>
  );
}
