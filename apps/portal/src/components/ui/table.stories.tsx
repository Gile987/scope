// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./table";
import { Badge } from "./badge";

const meta = {
  component: Table,
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

const rows = [
  { id: "run-001", worker: "coder-acp-copilot", status: "Done", outcome: "Succeeded" },
  { id: "run-002", worker: "coder-acp-copilot", status: "Running", outcome: "—" },
  { id: "run-003", worker: "coder-acp-claude-code", status: "Done", outcome: "Failed" },
];

export const Default: Story = {
  render: () => (
    <Table className="max-w-2xl">
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          <TableHead>Worker</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Outcome</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-mono">{r.id}</TableCell>
            <TableCell className="font-mono">{r.worker}</TableCell>
            <TableCell>{r.status}</TableCell>
            <TableCell>
              <Badge variant={r.outcome === "Succeeded" ? "success" : r.outcome === "Failed" ? "destructive" : "secondary"}>
                {r.outcome}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
  play: async ({ canvas }) => {
    // Column headers should be proper <th scope="col"> for accessibility.
    const header = canvas.getByText("Worker");
    await expect(header.tagName.toLowerCase()).toBe("th");
    await expect(header).toHaveAttribute("scope", "col");
  },
};
