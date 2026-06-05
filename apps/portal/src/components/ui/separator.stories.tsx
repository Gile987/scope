// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Separator } from "./separator";

const meta = {
  component: Separator,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: () => (
    <div className="max-w-sm">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">Scope</h4>
        <p className="text-sm text-muted-foreground">Benchmarking platform for AI coding agents.</p>
      </div>
      <Separator className="my-4" />
      <div className="flex h-5 items-center gap-4 text-sm">
        <span>Runs</span>
        <Separator orientation="vertical" />
        <span>Criteria</span>
        <Separator orientation="vertical" />
        <span>Reports</span>
      </div>
    </div>
  ),
};

export const Vertical: Story = {
  render: () => (
    <div className="flex h-8 items-center gap-4 text-sm">
      <span>Worker</span>
      <Separator orientation="vertical" />
      <span>Model</span>
    </div>
  ),
};
