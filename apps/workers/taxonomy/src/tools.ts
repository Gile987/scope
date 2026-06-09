// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineTool } from "@github/copilot-sdk";
import { BlobStorage, type ConversationTurn, type RequestDocument } from "shared";

interface GetAtifTrajectoryArgs {
  iteration?: number;
}

function resolveSnapshotsBlobName(blobUrl: string): string {
  const url = new URL(blobUrl);
  const containerPrefix = "/snapshots/";
  const containerIndex = url.pathname.indexOf(containerPrefix);
  if (containerIndex === -1) {
    throw new Error(`Blob URL does not contain the snapshots container: ${blobUrl}`);
  }
  return decodeURIComponent(url.pathname.substring(containerIndex + containerPrefix.length));
}

function selectTurnWithAtif(turns: ConversationTurn[] | undefined, requestedIteration?: number): ConversationTurn | undefined {
  if (!turns?.length) return undefined;

  if (requestedIteration !== undefined) {
    return turns.find((turn) => turn.iteration === requestedIteration && typeof turn.atifUrl === "string");
  }

  return [...turns]
    .filter((turn) => typeof turn.atifUrl === "string")
    .sort((a, b) => b.iteration - a.iteration)[0];
}

export function createTaxonomyTools(
  apiBaseUrl: string,
  requestId: string,
  blobStorage: BlobStorage,
) {
  const getRunData = defineTool("get_run_data", {
    description:
      "Fetch the full request document plus the active run state, including scenario, persona, turns, criteria results, and handler status.",
    parameters: {
      type: "object",
      properties: {},
    },
    handler: async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/requests/${requestId}`);
        if (!response.ok) {
          return { error: `Failed to fetch request: ${response.status} ${response.statusText}` };
        }

        const request: RequestDocument = await response.json();
        const run = request.run;

        return {
          request: {
            id: request._id,
            workerType: request.workerType,
            model: request.model,
            reasoningEffort: request.reasoningEffort,
            maxIterations: request.maxIterations,
            createdAt: request.createdAt,
            updatedAt: request.updatedAt,
            persona: request.persona,
            personaInstructions: request.personaInstructions,
            mcpServers: request.mcpServers,
            skillRevisions: request.skillRevisions,
            extensions: request.extensions,
            priority: request.priority,
            scenario: request.scenario,
          },
          run: run ? {
            id: run._id,
            attemptNumber: run.attemptNumber,
            status: run.status,
            outcome: run.outcome,
            result: run.result,
            error: run.error,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            updatedAt: run.updatedAt,
            aiCallCount: run.aiCallCount,
            tokenUsage: run.tokenUsage,
            handlerStatus: run.handlerStatus,
            turns: run.turns?.map((turn) => ({
              iteration: turn.iteration,
              passed: turn.passed,
              timestamp: turn.timestamp,
              startedAt: turn.startedAt,
              durationMs: turn.durationMs,
              judgeFeedback: turn.judgeFeedback,
              codingAgentResponse: turn.codingAgentResponse,
              aiCallCount: turn.aiCallCount,
              tokenUsage: turn.tokenUsage,
              snapshotUrl: turn.snapshotUrl,
              rawChatUrl: turn.rawChatUrl,
              rawChatFormat: turn.rawChatFormat,
              toolCallsUrl: turn.toolCallsUrl,
              toolCallCount: turn.toolCallCount,
              atifUrl: turn.atifUrl,
              criteriaResults: turn.criteriaResults,
            })) ?? [],
          } : null,
        };
      } catch (err) {
        return { error: `Failed to fetch run data: ${err}` };
      }
    },
  });

  const getAtifTrajectory = defineTool("get_atif_trajectory", {
    description:
      "Fetch an ATIF trajectory JSON document for a specific iteration, or the latest available iteration when omitted.",
    parameters: {
      type: "object",
      properties: {
        iteration: {
          type: "number",
          description: "Optional 1-based iteration number. If omitted, the latest available ATIF trajectory is returned.",
        },
      },
    },
    handler: async (args: GetAtifTrajectoryArgs) => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/requests/${requestId}`);
        if (!response.ok) {
          return { error: `Failed to fetch request: ${response.status} ${response.statusText}` };
        }

        const request: RequestDocument = await response.json();
        const selectedTurn = selectTurnWithAtif(request.run?.turns, args.iteration);

        if (!selectedTurn?.atifUrl) {
          return {
            error: args.iteration !== undefined
              ? `No ATIF trajectory available for iteration ${args.iteration}`
              : "No ATIF trajectory is available for this run",
          };
        }

        const blobName = resolveSnapshotsBlobName(selectedTurn.atifUrl);
        const buffer = await blobStorage.downloadBlobToBuffer(blobName);
        const trajectory: unknown = JSON.parse(buffer.toString("utf-8"));

        return {
          iteration: selectedTurn.iteration,
          trajectory,
        };
      } catch (err) {
        return { error: `Failed to fetch ATIF trajectory: ${err}` };
      }
    },
  });

  return [getRunData, getAtifTrajectory];
}
