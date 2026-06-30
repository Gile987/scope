// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, screen } from "storybook/test";
import { CriteriaFilterBar } from "./CriteriaFilterBar";

const FEW = [
  "hello_world_express",
  "api_contract_tests_pass",
  "fastapi_api_runs_locally",
  "uses_azure_cosmos_package",
  "cosmosdb_singleton_client_used",
  "data_integrity_tests_pass",
];

// Mimics the real-world case from the Statistics page where 100+ criteria would
// otherwise render as an unbounded chip cloud that fills the viewport.
const MANY = Array.from({ length: 120 }, (_, i) => `criteria_node_${String(i + 1).padStart(3, "0")}`);

/**
 * Stateful wrapper so the catalog (and play functions) can toggle selection just
 * like the real Statistics / MDP pages do via URL params.
 */
function FilterBarHarness({
  availableCriteria,
  initialSelected = [],
  ...rest
}: {
  availableCriteria: string[];
  initialSelected?: string[];
  title?: string;
  emptyDescription?: string;
  itemLabel?: string;
  compact?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>(initialSelected);
  return (
    <div className="max-w-3xl">
      <CriteriaFilterBar
        availableCriteria={availableCriteria}
        selectedCriteria={selected}
        onToggle={(id) =>
          setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
        }
        onClear={() => setSelected([])}
        onSelectAll={(ids) => setSelected(ids)}
        {...rest}
      />
    </div>
  );
}

const meta = {
  component: CriteriaFilterBar,
  // Default args satisfy the component's required props at the meta level; every
  // story overrides `render` with the stateful harness, so these are unused.
  args: {
    availableCriteria: FEW,
    selectedCriteria: [],
    onToggle: () => {},
    onClear: () => {},
  },
  tags: ["ai-generated", "needs-work"],
} satisfies Meta<typeof CriteriaFilterBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <FilterBarHarness availableCriteria={FEW} />,
};

export const ManyCriteria: Story = {
  render: () => <FilterBarHarness availableCriteria={MANY} />,
};

export const PreSelected: Story = {
  render: () => (
    <FilterBarHarness
      availableCriteria={FEW}
      initialSelected={["hello_world_express", "data_integrity_tests_pass"]}
    />
  ),
};

/**
 * Compact variant: no surrounding Card/header/description, just the picker
 * trigger and selected chips. Lets callers compose several filters into one
 * dense container.
 */
export const Compact: Story = {
  render: () => (
    <FilterBarHarness
      availableCriteria={FEW}
      compact
      initialSelected={["uses_azure_cosmos_package"]}
    />
  ),
};

/**
 * Two compact bars composed side by side, mirroring how the Statistics page
 * packs the Success Criteria and Task Prompt Feature pickers into one "Filters"
 * card instead of two stacked cards.
 */
export const CompactSideBySide: Story = {
  render: () => (
    <div className="grid max-w-3xl gap-x-6 gap-y-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <span className="text-sm font-medium">Success criteria</span>
        <FilterBarHarness
          availableCriteria={FEW}
          compact
          itemLabel="criteria"
          initialSelected={["hello_world_express"]}
        />
      </div>
      <div className="space-y-1.5">
        <span className="text-sm font-medium">Task prompt features</span>
        <FilterBarHarness
          availableCriteria={[
            "asks_for_azure",
            "asks_for_database",
            "asks_for_frontend",
          ]}
          compact
          itemLabel="features"
        />
      </div>
    </div>
  ),
};

export const Interactive: Story = {
  render: () => <FilterBarHarness availableCriteria={MANY} />,
  play: async ({ canvas }) => {
    // Open the popover from the compact trigger button. (Query by text rather
    // than accessible name: the label is nested under a span with icons.)
    await userEvent.click(canvas.getByText(/^filter criteria$/i));

    // Search narrows the list (popover content is portaled to the document body).
    const searchInput = await screen.findByPlaceholderText(/search criteria/i);
    await userEvent.type(searchInput, "node_007");

    // Selecting an option reflects in the trigger as a count + "Filtering by".
    await userEvent.click(await screen.findByText("criteria_node_007"));
    await expect(canvas.getByText(/^filtering by criteria$/i)).toBeVisible();
  },
};
