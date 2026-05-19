// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { CriteriaGraphView } from "./CriteriaGraphView";
import type { CriteriaGraphData, LogEvent } from "@/types";

const sampleGraph: CriteriaGraphData = {
  nodes: [
    { id: "code-runs", prompt: "The generated code runs without errors", dependsOn: [] },
    { id: "has-tests", prompt: "The project includes unit tests", dependsOn: ["code-runs"] },
    { id: "tests-pass", prompt: "All unit tests pass", dependsOn: ["has-tests"] },
    { id: "uses-typescript", prompt: "Code is written in TypeScript", dependsOn: ["code-runs"] },
    { id: "no-lint-errors", prompt: "No linting errors are present", dependsOn: ["code-runs"] },
  ],
  edges: [
    { source: "code-runs", target: "has-tests" },
    { source: "has-tests", target: "tests-pass" },
    { source: "code-runs", target: "uses-typescript" },
    { source: "code-runs", target: "no-lint-errors" },
  ],
};

const graphHandler = http.get("*/api/v1/criteria/graph", () =>
  HttpResponse.json(sampleGraph)
);

const scenarioCriteria = ["tests-pass", "uses-typescript", "no-lint-errors"];

function makeLog(criterionId: string, passed: boolean, evaluated: boolean): LogEvent {
  return {
    timestamp: new Date().toISOString(),
    level: "info",
    source: "judge",
    message: `criterion_result: ${criterionId}`,
    data: { type: "criterion_result", criterionId, passed, evaluated, feedback: "" },
  };
}

const meta = {
  component: CriteriaGraphView,
  tags: ["ai-generated"],
  decorators: [
    (Story) => (
      <div style={{ height: 300, width: "100%" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    msw: { handlers: [graphHandler] },
  },
} satisfies Meta<typeof CriteriaGraphView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllPending: Story = {
  args: {
    scenarioCriteria,
    logs: [],
  },
};

export const MixedResults: Story = {
  args: {
    scenarioCriteria,
    logs: [
      makeLog("code-runs", true, true),
      makeLog("has-tests", true, true),
      makeLog("tests-pass", false, true),
      makeLog("uses-typescript", true, true),
      makeLog("no-lint-errors", false, false), // skipped
    ],
  },
};

export const AllPassed: Story = {
  args: {
    scenarioCriteria,
    logs: [
      makeLog("code-runs", true, true),
      makeLog("has-tests", true, true),
      makeLog("tests-pass", true, true),
      makeLog("uses-typescript", true, true),
      makeLog("no-lint-errors", true, true),
    ],
  },
};

export const Loading: Story = {
  args: {
    scenarioCriteria,
    logs: [],
  },
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/v1/criteria/graph", () => new Promise(() => {})), // never resolves
      ],
    },
  },
};

export const Empty: Story = {
  args: {
    scenarioCriteria: ["nonexistent-criterion"],
    logs: [],
  },
};
