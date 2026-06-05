// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Stepper } from "./Stepper";

const meta = {
  component: Stepper,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Stepper>;

export default meta;
type Story = StoryObj<typeof meta>;

const steps = ["Scenario", "Criteria", "Agent", "Review"];

export const FirstStep: Story = {
  args: { steps, currentStep: 1 },
  play: async ({ canvas }) => {
    await expect(canvas.getByTitle("Scenario")).toBeVisible();
  },
};

export const MiddleStep: Story = {
  args: { steps, currentStep: 3 },
};

export const LastStep: Story = {
  args: { steps, currentStep: 4 },
};
