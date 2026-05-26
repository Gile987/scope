// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { ReportStatusBadge } from "./ReportStatusBadge";

const meta = {
  component: ReportStatusBadge,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof ReportStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  args: { status: "pending" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Pending")).toBeVisible();
  },
};

export const Generating: Story = {
  args: { status: "generating" },
};

export const Completed: Story = {
  args: { status: "completed" },
};

export const Failed: Story = {
  args: { status: "failed" },
};
