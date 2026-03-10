// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  CriteriaConfig,
  CriterionResult,
  ConversationTurn,
  DetailedEvaluationResult,
  DependencyGraph,
  normalizeCriteria,
} from "shared";
import { getCriteriaProvider } from "shared/criteria-provider-factory";
import { createJudgeStrategy } from "./judge-strategies.js";
import { FeedbackGenerator } from "./feedback-generator.js";

export interface EvaluationInput {
  workspacePath: string;
  criteria: string[];
  conversationHistory: ConversationTurn[];
  personaInstructions?: string;
  scenarioVersion?: "v1" | "v2";  // v1 = inline prompts, v2 = criteria IDs
  /** Called when an individual criterion result is available (for real-time progress) */
  onProgress?: (result: CriterionResult) => void;
}

export interface EvaluationResult {
  passed: boolean;
  feedback: string;
  criteriaResults: CriterionResult[];  // Per-criterion breakdown
}

/**
 * Evaluate workspace against criteria using the sophisticated DAG system
 *
 * This function:
 * 1. Normalizes criteria based on scenario version (v1 or v2)
 * 2. Builds criteria graph and validates DAG
 * 3. Selects judge strategy from environment (bundled or independent)
 * 4. Runs judge evaluation
 * 5. Generates natural language feedback if not all passed
 */
export async function evaluateWorkspace(
  input: EvaluationInput
): Promise<EvaluationResult> {
  // 1. Load strategy config from environment
  const strategyType =
    (process.env.JUDGE_STRATEGY as "bundled" | "independent") || "bundled";
  const maxParallelism = parseInt(process.env.JUDGE_MAX_PARALLELISM || "3");

  // 2. Load feedback config from environment
  const maxCriteria = parseInt(process.env.FEEDBACK_MAX_CRITERIA || "1");
  const includeDescendantGuard =
    process.env.FEEDBACK_DESCENDANT_GUARD !== "false";

  // 3. Determine scenario version and normalize criteria
  const scenarioVersion = input.scenarioVersion || "v1";
  let normalizedCriteria: CriteriaConfig[];

  if (scenarioVersion === "v2") {
    // v2: criteria are IDs, resolve from provider (API or filesystem)
    try {
      const provider = getCriteriaProvider();
      normalizedCriteria = await provider.resolveWithAncestors(input.criteria);
      console.log(
        `[judge-agent] Loaded ${normalizedCriteria.length} criteria (including ancestors) from provider (v2 format)`
      );
    } catch (error) {
      console.error("[judge-agent] Failed to resolve criteria:", error);
      throw new Error(
        `Failed to resolve criteria: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    // v1: criteria are prompts, auto-generate IDs
    normalizedCriteria = normalizeCriteria(input.criteria);
    console.log(
      `[judge-agent] Using ${normalizedCriteria.length} criteria (v1 format)`
    );
  }

  // 4. Build criteria graph (validates DAG)
  let criteriaGraph: DependencyGraph;
  try {
    criteriaGraph = new DependencyGraph(normalizedCriteria);
    console.log(
      `[judge-agent] Built criteria DAG with ${normalizedCriteria.length} nodes`
    );
  } catch (error) {
    console.error("[judge-agent] Failed to build criteria graph:", error);
    throw new Error(
      `Invalid criteria dependencies: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 5. Select and configure strategy
  const strategy = createJudgeStrategy(strategyType, { maxParallelism });
  console.log(
    `[judge-agent] Using ${strategyType} strategy${strategyType === "independent" ? ` (parallelism=${maxParallelism})` : ""}`
  );

  // 6. Run judge evaluation
  let judgeResult: DetailedEvaluationResult;
  try {
    judgeResult = await strategy.evaluate({
      workspacePath: input.workspacePath,
      criteria: normalizedCriteria,
      criteriaGraph,
      conversationHistory: input.conversationHistory,
      personaInstructions: input.personaInstructions,
      onProgress: input.onProgress,
    });

    console.log(
      `[judge-agent] Evaluation complete: ${judgeResult.results.filter((r) => r.passed).length}/${judgeResult.results.length} criteria passed`
    );
  } catch (error) {
    console.error("[judge-agent] Judge evaluation failed:", error);
    throw new Error(
      `Judge evaluation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 7. Generate feedback (if not all passed)
  let feedback: string;
  if (judgeResult.allPassed) {
    feedback = "All requirements met.";
    console.log("[judge-agent] All criteria passed");
  } else {
    try {
      const feedbackGen = new FeedbackGenerator();
      const feedbackResult = await feedbackGen.generateFeedback({
        judgeResults: judgeResult.results,
        criteriaGraph,
        criteriaRegistry: new Map(
          normalizedCriteria.map((c) => [c.id, c])
        ),
        personaInstructions: input.personaInstructions,
        maxCriteria,
        includeDescendantGuard,
      });

      feedback = feedbackResult.feedback;
      console.log(
        `[judge-agent] Generated feedback for ${feedbackResult.selectedCriteriaIds.length} root failures`
      );
    } catch (error) {
      console.error("[judge-agent] Feedback generation failed:", error);
      // Fallback to raw feedback from judge
      const failed = judgeResult.results.filter((r) => !r.passed);
      feedback =
        failed.length > 0
          ? failed
              .slice(0, maxCriteria)
              .map((r) => r.feedback)
              .join("\n\n")
          : "Requirements not met.";
    }
  }

  return {
    passed: judgeResult.allPassed,
    feedback,
    criteriaResults: judgeResult.results,
  };
}
