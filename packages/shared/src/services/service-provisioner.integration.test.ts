// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Integration test for the service provisioner.
 *
 * Requires Docker to be running and the ability to pull images.
 * Only runs when EPHEMERAL_SERVICES_TEST=1 is set.
 *
 * Usage:
 *   EPHEMERAL_SERVICES_TEST=1 npx vitest run packages/shared/src/services/service-provisioner.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { provisionServices, type ServiceContext } from "./service-provisioner.js";
import type { ServiceDeclaration } from "../types/types.js";

const SKIP = !process.env.EPHEMERAL_SERVICES_TEST;

describe.skipIf(SKIP)("service-provisioner (integration)", () => {
  const cosmosService: ServiceDeclaration = {
    name: "cosmosdb",
    image: "mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-latest",
    ports: [
      { host: 18081, container: 8081 },
      { host: 11234, container: 1234 },
      { host: 18080, container: 8080 },
    ],
    environment: {
      AZURE_COSMOS_EMULATOR_ENABLE_DATA_PERSISTENCE: "false",
    },
    healthCheck: {
      test: ["CMD", "curl", "-f", "http://localhost:8080/alive"],
      intervalSeconds: 5,
      timeoutSeconds: 3,
      retries: 30,
      startPeriodSeconds: 30,
    },
    envVars: {
      COSMOS_ENDPOINT: "http://localhost:${ports.8081}",
      COSMOS_KEY: "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==",
      COSMOS_DATABASE: "conference-planner",
    },
  };

  let context: ServiceContext;
  const logs: string[] = [];

  beforeAll(async () => {
    context = await provisionServices([cosmosService], {
      projectName: "scope-int-test",
      healthTimeoutMs: 180_000,
      log: (msg) => {
        logs.push(msg);
        console.log(`[provisioner] ${msg}`);
      },
    });
  }, 200_000); // 200s timeout for image pull + startup

  afterAll(async () => {
    if (context) {
      await context.cleanup();
    }
  }, 30_000);

  it("resolves COSMOS_ENDPOINT with the host port", () => {
    expect(context.envVars.COSMOS_ENDPOINT).toBe("http://localhost:18081");
  });

  it("resolves COSMOS_KEY with the emulator default key", () => {
    expect(context.envVars.COSMOS_KEY).toBe(
      "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==",
    );
  });

  it("resolves COSMOS_DATABASE", () => {
    expect(context.envVars.COSMOS_DATABASE).toBe("conference-planner");
  });

  it("emulator health endpoint is reachable", async () => {
    // The vNext emulator exposes health on port 8080 inside the container.
    // We didn't map 8080 to a host port, but we can verify the container is healthy
    // by checking docker inspect status (which the provisioner already verified).
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    const { stdout } = await execAsync(
      `docker inspect --format='{{.State.Health.Status}}' scope-int-test-cosmosdb`,
    );
    expect(stdout.trim().replace(/'/g, "")).toBe("healthy");
  });

  it("logs provisioning steps", () => {
    expect(logs.some((l) => l.includes("Starting ephemeral services"))).toBe(true);
    expect(logs.some((l) => l.includes("healthy"))).toBe(true);
  });
});
