// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { StatusBadge, OutcomeBadge } from "./StatusBadge";

const meta = {
  component: StatusBadge,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  args: { status: "pending" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Pending")).toBeVisible();
  },
};

export const Queued: Story = {
  args: { status: "queued" },
};

export const Processing: Story = {
  args: { status: "processing" },
};

export const Paused: Story = {
  args: { status: "paused" },
};

export const Done: Story = {
  args: { status: "done" },
};

// OutcomeBadge stories
export const Succeeded: Story = {
  render: () => <OutcomeBadge outcome="succeeded" />,
};

export const Failed: Story = {
  render: () => <OutcomeBadge outcome="failed" />,
};

export const Finished: Story = {
  render: () => <OutcomeBadge outcome="finished" />,
};

export const NoOutcome: Story = {
  render: () => <OutcomeBadge />,
};
