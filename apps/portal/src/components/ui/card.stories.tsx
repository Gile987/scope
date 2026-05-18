// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "./card";
import { Button } from "./button";

const meta = {
  component: Card,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithAllSections: Story = {
  render: () => (
    <Card className="w-[350px]">
      <CardHeader>
        <CardTitle>Run Configuration</CardTitle>
        <CardDescription>Configure parameters for a new benchmark run.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Select a scenario, persona, and agent to begin.</p>
      </CardContent>
      <CardFooter>
        <Button>Submit Run</Button>
      </CardFooter>
    </Card>
  ),
};

export const Simple: Story = {
  render: () => (
    <Card className="w-[350px]">
      <CardHeader>
        <CardTitle>Statistics</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold">42</p>
        <p className="text-xs text-muted-foreground">Runs completed today</p>
      </CardContent>
    </Card>
  ),
};
