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

export const ProcessingFresh: Story = {
  args: {
    status: "processing",
    lastHeartbeatAt: new Date(Date.now() - 5_000).toISOString(),
    startedAt: new Date(Date.now() - 120_000).toISOString(),
  },
  play: async ({ canvas }) => {
    const badge = canvas.getByText("Processing");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/animate-shimmer/);
  },
};

export const ProcessingStale: Story = {
  args: {
    status: "processing",
    lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    startedAt: new Date(Date.now() - 120_000).toISOString(),
  },
  play: async ({ canvas }) => {
    const badge = canvas.getByText("Processing");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/opacity-50/);
  },
};

export const Paused: Story = {
  args: { status: "paused" },
};

export const Done: Story = {
  args: { status: "done" },
};

// OutcomeBadge stories — use args with render to satisfy type constraint
export const Succeeded: Story = {
  args: { status: "done" },
  render: () => <OutcomeBadge outcome="succeeded" />,
};

export const Failed: Story = {
  args: { status: "done" },
  render: () => <OutcomeBadge outcome="failed" />,
};

export const Finished: Story = {
  args: { status: "done" },
  render: () => <OutcomeBadge outcome="finished" />,
};

export const NoOutcome: Story = {
  args: { status: "done" },
  render: () => <OutcomeBadge />,
};
