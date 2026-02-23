// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Backfill task prompt entities from existing runs.
 *
 * For each distinct `scenario.task` text across all request documents:
 *   1. Creates a TaskPromptDocument with UUIDv5-based _id (idempotent).
 *   2. Sets `taskPromptId` on all request documents that share that task text.
 *   3. Migrates prompt feature extraction data onto the task prompt entity
 *      (if a linked extraction exists).
 *
 * Down: Removes `taskPromptId` from request documents and drops the
 * `task-prompts` collection.
 */

import type { Db } from "mongodb";
import type { Migration } from "../types.js";
import { computeTaskPromptId } from "shared";

interface RequestDoc {
  _id: string;
  scenario?: { task?: string };
  promptFeatureExtractionId?: string;
  taskPromptId?: string;
}

interface ExtractionDoc {
  _id: string;
  taskText: string;
  promptFeatureResults?: Array<{ featureId: string; detected: boolean; evaluated: boolean }>;
  extractedAt?: Date;
}

export default class BackfillTaskPrompts implements Migration {
  description = "Create task-prompts collection and backfill taskPromptId on existing runs";

  async up(db: Db): Promise<void> {
    const requests = db.collection<RequestDoc>("requests");
    const taskPrompts = db.collection("task-prompts");
    const extractions = db.collection<ExtractionDoc>("prompt-feature-extractions");

    // 1. Find all distinct task texts from requests
    const distinctTasks: string[] = await requests.distinct("scenario.task", {
      "scenario.task": { $exists: true, $nin: [null, ""] },
    } as any);

    console.log(`  Found ${distinctTasks.length} distinct task texts`);

    let created = 0;
    let linked = 0;
    let featuresAttached = 0;

    for (const taskText of distinctTasks) {
      const trimmed = taskText.trim();
      if (!trimmed) continue;

      const id = computeTaskPromptId(trimmed);

      // 2. Upsert task prompt document (idempotent)
      const result = await taskPrompts.updateOne(
        { _id: id } as any,
        {
          $setOnInsert: {
            _id: id,
            text: trimmed,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount > 0) created++;

      // 3. Set taskPromptId on all matching request documents
      const updateResult = await requests.updateMany(
        { "scenario.task": taskText, taskPromptId: { $exists: false } } as any,
        { $set: { taskPromptId: id } },
      );
      linked += updateResult.modifiedCount;

      // 4. Try to find a linked extraction and attach features to the task prompt
      const reqWithExtraction = await requests.findOne({
        "scenario.task": taskText,
        promptFeatureExtractionId: { $exists: true },
      } as any);

      if (reqWithExtraction?.promptFeatureExtractionId) {
        const extraction = await extractions.findOne({
          _id: reqWithExtraction.promptFeatureExtractionId,
        } as any);

        if (extraction?.promptFeatureResults && extraction.promptFeatureResults.length > 0) {
          const featureUpdate = await taskPrompts.updateOne(
            { _id: id, features: { $exists: false } } as any,
            {
              $set: {
                features: extraction.promptFeatureResults,
                featuresExtractedAt: extraction.extractedAt ?? new Date(),
              },
            },
          );
          if (featureUpdate.modifiedCount > 0) featuresAttached++;
        }
      }
    }

    console.log(`  Created ${created} task prompt documents`);
    console.log(`  Linked ${linked} request documents with taskPromptId`);
    console.log(`  Attached features from extractions to ${featuresAttached} task prompts`);
  }

  async down(db: Db): Promise<void> {
    const requests = db.collection("requests");

    // Remove taskPromptId from all request documents
    const result = await requests.updateMany(
      { taskPromptId: { $exists: true } },
      { $unset: { taskPromptId: "" } },
    );
    console.log(`  Removed taskPromptId from ${result.modifiedCount} request documents`);

    // Drop the task-prompts collection
    await db.collection("task-prompts").drop().catch(() => {
      console.log("  task-prompts collection does not exist, skipping drop");
    });
    console.log("  Dropped task-prompts collection");
  }
}
