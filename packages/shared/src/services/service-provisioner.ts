// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceDeclaration } from "../types/types.js";

const execAsync = promisify(exec);

/**
 * Resolved service context after provisioning.
 * Contains the env vars to inject into the agent subprocess
 * and a cleanup function to destroy the containers.
 */
export interface ServiceContext {
  /** Environment variables resolved from the running service containers. */
  envVars: Record<string, string>;
  /** Destroy all provisioned containers. */
  cleanup(): Promise<void>;
}

/**
 * Options for the service provisioner.
 */
export interface ServiceProvisionerOptions {
  /** Timeout in ms to wait for all services to become healthy. Default: 120_000 */
  healthTimeoutMs?: number;
  /** Project name for Docker Compose (isolates containers per run). */
  projectName?: string;
  /** Logger function for status updates. */
  log?: (message: string) => void;
}

/**
 * Resolves env var templates from a ServiceDeclaration.
 *
 * Templates can reference port mappings via `${ports.<container_port>}`.
 * For the POC, ports resolve to the declared host port.
 */
function resolveEnvVars(
  service: ServiceDeclaration,
): Record<string, string> {
  const portMap = new Map(
    service.ports.map((p) => [String(p.container), String(p.host)]),
  );

  const resolved: Record<string, string> = {};
  for (const [key, template] of Object.entries(service.envVars)) {
    resolved[key] = template.replace(
      /\$\{ports\.(\d+)\}/g,
      (_match, containerPort: string) => {
        const hostPort = portMap.get(containerPort);
        if (!hostPort) {
          throw new Error(
            `Service "${service.name}": env var "${key}" references port ${containerPort} ` +
            `which is not in the ports mapping`,
          );
        }
        return hostPort;
      },
    );
  }
  return resolved;
}

/**
 * Generates a Docker Compose YAML fragment for ephemeral services.
 * Used to create a temporary compose file for provisioning.
 */
function generateComposeYaml(services: ServiceDeclaration[], projectName: string): string {
  const serviceEntries = services.map((svc) => {
    const ports = svc.ports
      .map((p) => `      - "${p.host}:${p.container}"`)
      .join("\n");

    const envLines = svc.environment
      ? Object.entries(svc.environment)
          .map(([k, v]) => `        ${k}: "${v}"`)
          .join("\n")
      : "";

    const healthCheck = svc.healthCheck
      ? `    healthcheck:
      test: ${JSON.stringify(svc.healthCheck.test)}
      interval: ${svc.healthCheck.intervalSeconds}s
      timeout: ${svc.healthCheck.timeoutSeconds}s
      retries: ${svc.healthCheck.retries}
      start_period: ${svc.healthCheck.startPeriodSeconds}s`
      : "";

    return `  ${svc.name}:
    image: ${svc.image}
    container_name: ${projectName}-${svc.name}
    ports:
${ports}${envLines ? `\n    environment:\n${envLines}` : ""}${healthCheck ? `\n${healthCheck}` : ""}`;
  });

  return `services:\n${serviceEntries.join("\n\n")}`;
}

/**
 * Waits for a service to become healthy by polling its health check endpoint.
 */
async function waitForHealthy(
  containerName: string,
  timeoutMs: number,
  log?: (message: string) => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 2000;

  while (Date.now() < deadline) {
    try {
      const { stdout } = await execAsync(
        `docker inspect --format='{{.State.Health.Status}}' ${containerName}`,
      );
      const status = stdout.trim().replace(/'/g, "");
      if (status === "healthy") {
        log?.(`Container ${containerName} is healthy`);
        return;
      }
      log?.(`Container ${containerName} status: ${status}, waiting...`);
    } catch {
      // Container may not exist yet
      log?.(`Container ${containerName} not ready, waiting...`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for container "${containerName}" to become healthy after ${timeoutMs}ms`,
  );
}

/**
 * Provisions ephemeral service containers for a scenario run.
 *
 * This POC implementation uses Docker Compose to start containers locally.
 * The production implementation will use Kubedock for K8s-native provisioning.
 *
 * @param services - Service declarations from the scenario
 * @param options - Provisioner options
 * @returns ServiceContext with resolved env vars and cleanup function
 */
export async function provisionServices(
  services: ServiceDeclaration[],
  options?: ServiceProvisionerOptions,
): Promise<ServiceContext> {
  if (services.length === 0) {
    return { envVars: {}, cleanup: async () => {} };
  }

  const projectName = options?.projectName ?? `scope-ephemeral-${Date.now()}`;
  const healthTimeoutMs = options?.healthTimeoutMs ?? 120_000;
  const log = options?.log;

  // Generate compose file content
  const composeYaml = generateComposeYaml(services, projectName);
  log?.(`Generated compose config for project: ${projectName}`);

  // Write temporary compose file
  const { writeFile, unlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const composeFilePath = join(tmpdir(), `${projectName}-compose.yml`);
  await writeFile(composeFilePath, composeYaml, "utf-8");

  try {
    // Start services
    log?.("Starting ephemeral services...");
    await execAsync(
      `docker compose -f "${composeFilePath}" -p "${projectName}" up -d`,
    );

    // Wait for all services to become healthy
    const hasHealthChecks = services.filter((s) => s.healthCheck);
    if (hasHealthChecks.length > 0) {
      log?.(`Waiting for ${hasHealthChecks.length} service(s) to become healthy...`);
      await Promise.all(
        hasHealthChecks.map((svc) =>
          waitForHealthy(`${projectName}-${svc.name}`, healthTimeoutMs, log),
        ),
      );
    }

    // Resolve env vars from all services
    const envVars: Record<string, string> = {};
    for (const svc of services) {
      const resolved = resolveEnvVars(svc);
      Object.assign(envVars, resolved);
    }
    log?.(`Resolved ${Object.keys(envVars).length} env var(s) from services`);

    // Build cleanup function
    const cleanup = async (): Promise<void> => {
      log?.(`Tearing down ephemeral services (project: ${projectName})...`);
      try {
        await execAsync(
          `docker compose -f "${composeFilePath}" -p "${projectName}" down -v --remove-orphans`,
        );
      } finally {
        await unlink(composeFilePath).catch(() => {});
      }
      log?.("Ephemeral services destroyed");
    };

    return { envVars, cleanup };
  } catch (error) {
    // Cleanup on failure
    await execAsync(
      `docker compose -f "${composeFilePath}" -p "${projectName}" down -v --remove-orphans`,
    ).catch(() => {});
    await unlink(composeFilePath).catch(() => {});
    throw error;
  }
}

// Export for testing
export { resolveEnvVars as _resolveEnvVars, generateComposeYaml as _generateComposeYaml };
