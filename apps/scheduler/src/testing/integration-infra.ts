// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Testcontainers-backed infra for scheduler integration tests
 * (MongoDB + Redis + Azurite).
 *
 * Mirrors packages/shared/src/testing/integration-infra.ts (kept per-package so
 * each suite is self-contained and build-safe under its own tsconfig rootDir).
 * Each starter boots a throwaway container and returns its dynamically mapped
 * coordinates plus a stop() handle — no fixed/worktree-offset ports, no need to
 * run `pnpm docker:up:infra` first. Ryuk reaps anything left if the process
 * dies. Imported ONLY by *.integration.test.ts files (`testcontainers` is a
 * devDependency, never used by production code).
 */
import { GenericContainer, Wait, getContainerRuntimeClient } from "testcontainers";

// Disable the Ryuk reaper container. Ryuk is only a backstop that force-removes
// leaked containers if the test process dies; our helpers already stop() every
// container in afterAll (failure-safe). Ryuk's own startup (a separate
// container whose readiness is gated on a "Started" log line) is fragile on
// some Docker setups (rootless/Colima/constrained CI) and, when it fails, makes
// getContainerRuntimeClient() — and therefore the whole suite — error out. Opt
// out so infra provisioning depends only on the images we actually use.
process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

// Azurite's well-known dev-account credentials (identical to docker-compose).
export const AZURITE_ACCOUNT = "devstoreaccount1";
export const AZURITE_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

// Pin the same images docker-compose uses, to avoid drift with dev infra.
const MONGO_IMAGE = "mongo:7.0";
const REDIS_IMAGE = "redis:7.4.2-alpine";
const AZURITE_IMAGE = "mcr.microsoft.com/azure-storage/azurite:3.29.0";

export interface StartedMongo {
  uri: string;
  stop(): Promise<void>;
}

export interface StartedRedis {
  host: string;
  port: number;
  stop(): Promise<void>;
}

export interface StartedAzurite {
  host: string;
  queuePort: number;
  /** Connection string targeting the dynamically mapped queue endpoint. */
  connectionString: string;
  stop(): Promise<void>;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * True if a Docker daemon is reachable. Suites use this to skip locally when
 * Docker is absent; in CI the tests FAIL instead of skipping (see each file).
 */
export async function isDockerAvailable(timeoutMs = 10_000): Promise<boolean> {
  try {
    await withTimeout(getContainerRuntimeClient(), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export async function startMongo(): Promise<StartedMongo> {
  const container = await new GenericContainer(MONGO_IMAGE)
    .withExposedPorts(27017)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const uri = `mongodb://${container.getHost()}:${container.getMappedPort(27017)}`;
  return {
    uri,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function startRedis(): Promise<StartedRedis> {
  const container = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  return {
    host: container.getHost(),
    port: container.getMappedPort(6379),
    stop: async () => {
      await container.stop();
    },
  };
}

export async function startAzurite(): Promise<StartedAzurite> {
  const container = await new GenericContainer(AZURITE_IMAGE)
    .withExposedPorts(10000, 10001)
    .withCommand([
      "azurite",
      "--loose",
      "--skipApiVersionCheck",
      "--blobHost",
      "0.0.0.0",
      "--queueHost",
      "0.0.0.0",
      "--tableHost",
      "0.0.0.0",
      "--location",
      "/data",
    ])
    // Azurite returns HTTP 400 on GET / once the queue service is listening
    // (the same probe docker-compose's healthcheck uses).
    .withWaitStrategy(Wait.forHttp("/", 10001).forStatusCode(400))
    .start();
  const host = container.getHost();
  const queuePort = container.getMappedPort(10001);
  const connectionString =
    `DefaultEndpointsProtocol=http;AccountName=${AZURITE_ACCOUNT};AccountKey=${AZURITE_KEY};` +
    `QueueEndpoint=http://${host}:${queuePort}/${AZURITE_ACCOUNT};`;
  return {
    host,
    queuePort,
    connectionString,
    stop: async () => {
      await container.stop();
    },
  };
}
