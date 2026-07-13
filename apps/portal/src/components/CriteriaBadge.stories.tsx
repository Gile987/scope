// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { CriteriaBadge } from "./CriteriaBadge";

const meta = {
  component: CriteriaBadge,
  tags: ["ai-generated", "needs-work"],
  args: {
    criterionId: "has-automated-tests",
    prompt: "The project must include automated tests that pass.",
  },
} satisfies Meta<typeof CriteriaBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    const link = canvas.getByRole("link");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/criteria/has-automated-tests");
  },
};

export const Passed: Story = {
  args: { evaluated: true, result: true, showStateLabel: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/has-automated-tests: /)).toBeVisible();
  },
};

export const Failed: Story = {
  args: { evaluated: true, result: false, showStateLabel: true },
};

export const NotEvaluated: Story = {
  args: { evaluated: true, result: undefined, showStateLabel: true },
};

export const NonLinking: Story = {
  args: { link: false },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("link")).toBeNull();
  },
};

export const WithoutPreloadedPrompt: Story = {
  // No `prompt` prop — the prompt is fetched lazily the first time the
  // tooltip opens (handled by the global MSW + Query decorators in Storybook).
  args: { prompt: undefined },
};
