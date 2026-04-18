// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Shared Docker test helpers for coder-acp-claude-code integration tests.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import Docker from "dockerode";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSIONS_ENV_PATH = resolve(__dirname, "..", "versions.env");

export function loadVersions(): Record<string, string> {
  return dotenv.parse(readFileSync(VERSIONS_ENV_PATH));
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    const docker = new Docker();
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

export async function imageExists(docker: Docker, tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a Docker image, checking for build-level errors that dockerode
 * otherwise swallows silently.
 */
export async function buildImage(
  docker: Docker,
  opts: {
    context: string;
    tag: string;
    dockerfile: string;
    buildargs: Record<string, string>;
    target?: string;
  },
): Promise<void> {
  const buildStream = await docker.buildImage(
    { context: opts.context, src: ["."] },
    {
      t: opts.tag,
      dockerfile: opts.dockerfile,
      buildargs: opts.buildargs,
      ...(opts.target && { target: opts.target }),
    },
  );

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      buildStream,
      (err: Error | null, output: Array<{ error?: string }>) => {
        if (err) return reject(err);
        const buildError = output?.find((o) => o.error);
        if (buildError) {
          return reject(new Error(`Docker build failed: ${buildError.error}`));
        }
        resolve();
      },
      (event: { stream?: string; error?: string }) => {
        if (event.stream) process.stderr.write(event.stream);
        if (event.error) process.stderr.write(`ERROR: ${event.error}\n`);
      },
    );
  });
}
