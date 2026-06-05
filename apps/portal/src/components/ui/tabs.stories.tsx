// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";

const meta = {
  component: Tabs,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="logs" className="w-[420px]">
      <TabsList>
        <TabsTrigger value="logs">Logs</TabsTrigger>
        <TabsTrigger value="timeline">Timeline</TabsTrigger>
        <TabsTrigger value="network">Network</TabsTrigger>
      </TabsList>
      <TabsContent value="logs" className="text-sm text-muted-foreground">
        Streaming logs for the selected run.
      </TabsContent>
      <TabsContent value="timeline" className="text-sm text-muted-foreground">
        Per-iteration turn timeline.
      </TabsContent>
      <TabsContent value="network" className="text-sm text-muted-foreground">
        Captured HAR network requests.
      </TabsContent>
    </Tabs>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/streaming logs/i)).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Timeline" }));
    await expect(canvas.getByText(/turn timeline/i)).toBeVisible();
  },
};
