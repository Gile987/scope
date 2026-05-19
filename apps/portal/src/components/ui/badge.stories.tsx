// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Badge } from "./badge";

const meta = {
  component: Badge,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: "Badge" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Badge")).toBeVisible();
  },
};

export const Secondary: Story = {
  args: { variant: "secondary", children: "Secondary" },
};

export const Destructive: Story = {
  args: { variant: "destructive", children: "Error" },
};

export const Success: Story = {
  args: { variant: "success", children: "Passed" },
};

export const Warning: Story = {
  args: { variant: "warning", children: "Warning" },
};

export const Info: Story = {
  args: { variant: "info", children: "Processing" },
};

export const Purple: Story = {
  args: { variant: "purple", children: "Queued" },
};

export const Outline: Story = {
  args: { variant: "outline", children: "v1.2.3" },
};
