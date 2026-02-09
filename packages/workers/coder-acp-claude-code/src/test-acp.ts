#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Quick test script for the ACP client
 * Usage: npx tsx src/test-acp.ts "your prompt here"
 */

import { runACPSession } from "./acp-client.js";

async function main() {
  const prompt = process.argv[2] || "Say hello in one sentence.";
  
  console.log("Testing ACP client with Claude Code...\n");
  console.log(`Prompt: ${prompt}\n`);
  console.log("---");

  try {
    const result = await runACPSession(prompt, {
      command: "claude-code",
      args: ["--acp"],
      env: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
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
