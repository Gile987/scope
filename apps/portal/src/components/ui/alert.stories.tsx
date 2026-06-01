// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { Terminal, AlertCircle } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "./alert";

const meta = {
  component: Alert,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Alert className="max-w-md">
      <Terminal className="h-4 w-4" />
      <AlertTitle>Heads up!</AlertTitle>
      <AlertDescription>The benchmark run has been queued and will start shortly.</AlertDescription>
    </Alert>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Heads up!")).toBeVisible();
  },
};

export const Destructive: Story = {
  render: () => (
    <Alert variant="destructive" className="max-w-md">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Run failed</AlertTitle>
      <AlertDescription>The worker exited with a non-zero status code.</AlertDescription>
    </Alert>
  ),
};
