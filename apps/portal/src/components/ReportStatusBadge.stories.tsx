// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReportStatusBadge } from "./ReportStatusBadge";

const meta = {
  title: "Components/ReportStatusBadge",
  component: ReportStatusBadge,
  argTypes: {
    status: {
      control: "select",
      options: ["pending", "generating", "completed", "failed"],
    },
  },
} satisfies Meta<typeof ReportStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  args: { status: "pending" },
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
