// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { ShortId } from "./ShortId";

const FULL_ID = "abcdef1234567890fedcba";

const meta = {
  component: ShortId,
  tags: ["ai-generated", "needs-work"],
  args: {
    id: FULL_ID,
  },
} satisfies Meta<typeof ShortId>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvas }) => {
    // The trigger shows only the first 8 characters by default.
    await expect(canvas.getByText("abcdef12")).toBeVisible();
  },
};

export const CustomLength: Story = {
  args: { length: 4 },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("abcd")).toBeVisible();
  },
};

export const HoverRevealsFullIdAndCopy: Story = {
  play: async ({ canvas }) => {
    await userEvent.hover(canvas.getByText("abcdef12"));
    // The full id and a copy button appear in the hoverable tooltip content.
    const button = await canvas.findByRole("button", { name: /copy/i });
    await expect(button).toBeVisible();
    await expect(canvas.getAllByText(FULL_ID).length).toBeGreaterThan(0);
  },
};
