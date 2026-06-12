// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { Layout } from "./Layout";

const meta = {
  component: Layout,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Layout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {
  play: async ({ canvas }) => {
    localStorage.removeItem("scope:layout:sidebar-expanded");
    await expect(canvas.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  },
};

export const Expanded: Story = {
  play: async ({ canvas }) => {
    localStorage.removeItem("scope:layout:sidebar-expanded");
    await userEvent.click(canvas.getByRole("button", { name: "Expand sidebar" }));
    await expect(canvas.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Runs" })).toBeVisible();
  },
};

