// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { _resolveEnvVars, _generateComposeYaml } from "./service-provisioner.js";
import type { ServiceDeclaration } from "../types/types.js";

describe("service-provisioner", () => {
  const cosmosService: ServiceDeclaration = {
    name: "cosmosdb",
    image: "mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-latest",
    ports: [
      { host: 8081, container: 8081 },
      { host: 1234, container: 1234 },
    ],
    environment: {
      AZURE_COSMOS_EMULATOR_ENABLE_DATA_PERSISTENCE: "false",
    },
    healthCheck: {
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"],
      intervalSeconds: 5,
      timeoutSeconds: 3,
      retries: 30,
      startPeriodSeconds: 30,
    },
    envVars: {
      COSMOS_ENDPOINT: "https://localhost:${ports.8081}",
      COSMOS_KEY: "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==",
      COSMOS_DATABASE: "conference-planner",
    },
  };

  describe("resolveEnvVars", () => {
    it("resolves port templates to host ports", () => {
      const result = _resolveEnvVars(cosmosService);

      expect(result.COSMOS_ENDPOINT).toBe("https://localhost:8081");
      expect(result.COSMOS_KEY).toBe(
        "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==",
      );
      expect(result.COSMOS_DATABASE).toBe("conference-planner");
    });

    it("throws when referencing an unmapped port", () => {
      const service: ServiceDeclaration = {
        name: "test",
        image: "test:latest",
        ports: [{ host: 3000, container: 3000 }],
        envVars: { URL: "http://localhost:${ports.9999}" },
      };

      expect(() => _resolveEnvVars(service)).toThrow(
        'Service "test": env var "URL" references port 9999',
      );
    });

    it("handles templates with no port references", () => {
      const service: ServiceDeclaration = {
        name: "test",
        image: "test:latest",
        ports: [{ host: 3000, container: 3000 }],
        envVars: { DB_NAME: "my-database" },
      };

      expect(_resolveEnvVars(service)).toEqual({ DB_NAME: "my-database" });
    });
  });

  describe("generateComposeYaml", () => {
    it("generates valid YAML structure", () => {
      const yaml = _generateComposeYaml([cosmosService], "test-project");

      expect(yaml).toContain("services:");
      expect(yaml).toContain("cosmosdb:");
      expect(yaml).toContain("mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-latest");
      expect(yaml).toContain("test-project-cosmosdb");
      expect(yaml).toContain('"8081:8081"');
      expect(yaml).toContain('"1234:1234"');
      expect(yaml).toContain("AZURE_COSMOS_EMULATOR_ENABLE_DATA_PERSISTENCE");
      expect(yaml).toContain("healthcheck:");
    });

    it("handles services without health checks", () => {
      const service: ServiceDeclaration = {
        name: "simple",
        image: "nginx:latest",
        ports: [{ host: 8080, container: 80 }],
        envVars: { URL: "http://localhost:${ports.80}" },
      };

      const yaml = _generateComposeYaml([service], "test");
      expect(yaml).toContain("simple:");
      expect(yaml).not.toContain("healthcheck:");
    });

    it("handles services without environment", () => {
      const service: ServiceDeclaration = {
        name: "minimal",
        image: "redis:7",
        ports: [{ host: 6379, container: 6379 }],
        envVars: { REDIS_URL: "redis://localhost:${ports.6379}" },
      };

      const yaml = _generateComposeYaml([service], "test");
      expect(yaml).toContain("minimal:");
      expect(yaml).not.toContain("environment:");
    });
  });
});
