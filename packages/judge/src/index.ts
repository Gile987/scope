// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import { evaluateWorkspace } from "./judge-agent.js";
import { BlobStorage } from "shared";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));

const port = parseInt(process.env.PORT || "3000", 10);
const storageAccountName = process.env.AZURE_STORAGE_ACCOUNT_NAME || "";
const storageConnectionString =
  process.env.STORAGE_CONNECTION_STRING ||
  process.env.AZURE_STORAGE_CONNECTION_STRING ||
  "";

const blobStorage = new BlobStorage({
  storageAccountName,
  storageConnectionString: storageConnectionString || undefined,
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "healthy", service: "judge", version: "1.0.0" });
});

// Evaluate endpoint — called by coding workers after each iteration
app.post(
  "/api/v1/evaluate",
  async (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    try {
      const { snapshotUrl, criteria, conversationHistory, personaInstructions } = req.body;

      // Validate required fields
      if (!snapshotUrl || typeof snapshotUrl !== "string") {
        res.status(400).json({ error: "snapshotUrl is required and must be a string" });
        return;
      }

      if (
        !criteria ||
        !Array.isArray(criteria) ||
        criteria.length === 0 ||
        !criteria.every((c: unknown) => typeof c === "string")
      ) {
        res.status(400).json({
          error: "criteria is required and must be a non-empty array of strings",
        });
        return;
      }

      if (conversationHistory && !Array.isArray(conversationHistory)) {
        res.status(400).json({ error: "conversationHistory must be an array" });
        return;
      }

      console.log(
        `[judge] Evaluating snapshot: ${snapshotUrl} (${criteria.length} criteria, ${conversationHistory?.length || 0} prior turns)`
      );

      // Download and extract workspace snapshot to temp directory
      const workDir = mkdtempSync(join(tmpdir(), "judge-workspace-"));

      try {
        await blobStorage.downloadAndExtractSnapshot(snapshotUrl, workDir);

        console.log(`[judge] Snapshot extracted to ${workDir}`);

        // Run the judge agent
        const result = await evaluateWorkspace({
          workspacePath: workDir,
          criteria,
          conversationHistory: conversationHistory || [],
          personaInstructions,
        });

        const elapsed = Date.now() - startTime;
        console.log(
          `[judge] Evaluation complete in ${elapsed}ms: passed=${result.passed}`
        );

        res.json(result);
      } finally {
        // Clean up extracted workspace
        rmSync(workDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error("[judge] Evaluation error:", error);
      next(error);
    }
  }
);

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[judge] Error:", err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

async function main(): Promise<void> {
  app.listen(port, () => {
    console.log(`[judge] Judge service listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error("[judge] Failed to start:", error);
  process.exit(1);
});
