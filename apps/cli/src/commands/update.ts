// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { execSync } from "node:child_process";
import { getCliName } from "../utils/shared.js";

const REPO = "growth-ecosystems/scope-doc";

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Update the CLI to the latest version")
    .action(async () => {
      const cli = getCliName();
      if (cli !== "scope") {
        console.error(
          "The update command is only available for standalone installations.\n" +
            "In dev mode, pull the latest code and rebuild instead.",
        );
        process.exit(1);
      }

      console.log("Checking for updates...");

      try {
        execSync(
          `gh release download --repo ${REPO} --pattern install.sh -O - | bash`,
          { stdio: "inherit" },
        );
      } catch {
        console.error(
          "\nUpdate failed. You can update manually:\n" +
            `  gh release download --repo ${REPO} --pattern install.sh -O - | bash`,
        );
        process.exit(1);
      }
    });
}
