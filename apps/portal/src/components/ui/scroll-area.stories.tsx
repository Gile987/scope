// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { ScrollArea } from "./scroll-area";
import { Separator } from "./separator";

const meta = {
  component: ScrollArea,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

const tags = Array.from({ length: 30 }).map((_, i) => `criteria-node-${i + 1}`);

export const Default: Story = {
  render: () => (
    <ScrollArea className="h-72 w-64 rounded-md border">
      <div className="p-4">
        <h4 className="mb-4 text-sm font-medium">Criteria</h4>
        {tags.map((tag) => (
          <div key={tag}>
            <div className="font-mono text-sm">{tag}</div>
            <Separator className="my-2" />
          </div>
        ))}
      </div>
    </ScrollArea>
  ),
};

export const TruncatedRows: Story = {
  render: () => (
    <ScrollArea className="h-48 w-72 rounded-md border">
      <ul className="divide-y">
        {Array.from({ length: 12 }).map((_, i) => (
          <li key={i} className="flex items-start gap-2 p-2">
            <div className="flex-1 min-w-0">
              <div className="font-mono text-xs font-medium">skill-{i + 1}</div>
              <p className="text-xs text-muted-foreground truncate">
                A very long single-line description that must truncate with an
                ellipsis instead of forcing the ScrollArea to grow horizontally.
              </p>
            </div>
          </li>
        ))}
      </ul>
    </ScrollArea>
  ),
};
