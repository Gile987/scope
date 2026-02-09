#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Quick test script for the ACP client with Copilot
 * Usage: npx tsx src/test-acp.ts "your prompt here"
 */

import { runACPSession } from "./acp-client.js";

async function main() {
  const prompt = process.argv[2] || "Say hello in one sentence.";
  
  console.log("Testing ACP client with GitHub Copilot...\n");
  console.log(`Prompt: ${prompt}\n`);
  console.log("---");

  try {
    const result = await runACPSession(prompt, {
      command: "copilot",
      args: ["--acp"],
      env: {
        GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
      },
      cwd: process.cwd(),
      onLog: (msg) => console.log(`[LOG] ${msg}`),
    });

    console.log("\n--- Result ---");
    console.log(`Stop reason: ${result.stopReason}`);
    console.log(`Response:\n${result.response}`);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
