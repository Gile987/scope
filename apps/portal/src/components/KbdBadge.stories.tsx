// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { KbdBadge } from "./KbdBadge";

const meta = {
  component: KbdBadge,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof KbdBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CustomClass: Story = {
  args: { className: "text-xs" },
};
