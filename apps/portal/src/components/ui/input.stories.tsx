// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Input } from "./input";

const meta = {
  component: Input,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { placeholder: "Enter scenario name..." },
  play: async ({ canvas }) => {
    const input = canvas.getByPlaceholderText("Enter scenario name...");
    await expect(input).toBeVisible();
    await expect(input.tagName.toLowerCase()).toBe("input");
  },
};

export const WithValue: Story = {
  args: { defaultValue: "hello-world-express" },
};

export const Disabled: Story = {
  args: { placeholder: "Disabled input", disabled: true },
};
