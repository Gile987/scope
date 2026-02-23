// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import dotenv from "dotenv";
dotenv.config();

import { TokenManagerClient } from "shared";
import {
  parseScannerArgs,
  waitForApi,
  upsertAgent,
  reconcileModels,
} from "model-scanning";
import { scanCopilotModels } from "./scan.js";

const AGENT_ID = "coder-acp-copilot";
const AGENT_DEFINITION = {
  _id: AGENT_ID,
  name: "Copilot (ACP)",
  description: "GitHub Copilot coding agent via ACP protocol",
  supportedModels: [] as string[],  // Will be populated by scan
};

async function main(): Promise<void> {
  const { dryRun, apiUrl } = parseScannerArgs();
  const tokenClient = new TokenManagerClient();

  console.log(`Model scanner: copilot (agent: ${AGENT_ID})`);
  console.log(`Mode: ${dryRun ? "dry-run" : "live"}`);

  // Acquire token
  console.log("Acquiring token for copilot-cli capability...");
  const token = await tokenClient.acquireToken("copilot-cli");
  console.log("Token acquired.");

  // Scan models
  console.log("Scanning GitHub Copilot models...");
  const scanResult = await scanCopilotModels(token);
  console.log(`Found ${scanResult.models.length} models:`);
  for (const model of scanResult.models) {
    console.log(`  - ${model.id}`);
  }

  if (dryRun) {
    // Dry-run: output JSON and exit
    console.log("\n--- Dry-run output ---");
    console.log(JSON.stringify(scanResult, null, 2));
    process.exit(0);
  }

  // Live mode: wait for API, upsert agent, sync models
  console.log(`Waiting for API at ${apiUrl}...`);
  await waitForApi(apiUrl);

  // Upsert agent definition (creates if doesn't exist)
  console.log("Upserting agent definition...");
  await upsertAgent(apiUrl, {
    ...AGENT_DEFINITION,
    supportedModels: scanResult.models.map((m) => m.id),
  });

  // Sync models with lifecycle tracking
  console.log("Syncing models...");
  const report = await reconcileModels(
    apiUrl,
    AGENT_ID,
    "github-copilot",
    scanResult,
  );
  console.log(
    `Sync complete: +${report.added.length} added, -${report.removed.length} removed, =${report.unchanged.length} unchanged`,
  );
  if (report.added.length > 0) console.log(`  Added: ${report.added.join(", ")}`);
  if (report.removed.length > 0) console.log(`  Removed: ${report.removed.join(", ")}`);

  console.log("Done.");
}

main().catch((error) => {
  console.error("Model scanner failed:", error);
  process.exit(1);
});
