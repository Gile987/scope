// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import Docker from "dockerode";
import { createInterface } from "readline";
import { existsSync, readFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { resolve, join } from "path";
import { resolveScenarioAndPersona, DirectRunRequest } from "shared";
import tar from "tar-fs";
import { banner, label, value, errorText, successText, dimTimestamp, colorLevel, criterionIcon } from "../utils/style.js";

const KNOWN_WORKERS = [
  "coder-acp-copilot",
  "coder-acp-claude-code",
  "coder-vscode-web",
];

interface WorkerRunOptions {
  name?: string;
  scenario: string;
  persona?: string;
  traits?: string;
  maxIterations: string;
  workspace?: string;
  judgeUrl?: string;
  envFile?: string;
  context?: string;
}

/**
 * Parse a dotenv-style file into a Record<string, string>.
 */
function parseEnvFile(filePath: string): Record<string, string> {
  const content = readFileSync(filePath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    let val = trimmed.substring(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

export function workerRunCommand(): Command {
  const cmd = new Command("run")
    .description("Build a worker Docker image and run a task directly (bypassing the queue)")
    .option("-n, --name <worker>", `Worker name (${KNOWN_WORKERS.join(", ")})`)
    .requiredOption("-s, --scenario <path>", "Path to scenario YAML file")
    .option("-p, --persona <path>", "Path to persona YAML file")
    .option("-t, --traits <path>", "Path to traits YAML file")
    .option("-m, --max-iterations <n>", "Max iterations for multi-turn", "10")
    .option("-w, --workspace <path>", "Local directory to bind-mount as /workspace (default: temp dir)")
    .option("-j, --judge-url <url>", "Judge service URL", process.env.JUDGE_SERVICE_URL || "http://localhost:3101")
    .option("-e, --env-file <path>", "Env file with worker-specific variables (e.g. GITHUB_TOKEN)")
    .option("-c, --context <path>", "Docker build context path (default: auto-detect)")
    .action(async (opts: WorkerRunOptions) => {
      try {
        await runWorker(opts);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`\n${errorText('✗ Error:')} ${msg}`);
        process.exit(1);
      }
    });

  return cmd;
}

/**
 * Prompt the user to select a worker from a numbered list.
 */
async function promptWorkerSelection(): Promise<string> {
  console.log(`\n${label('Select a worker:')}`);
  for (let i = 0; i < KNOWN_WORKERS.length; i++) {
    console.log(`  ${value(String(i + 1))}. ${KNOWN_WORKERS[i]}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n${label('Enter number')} ${dimTimestamp(`[1-${KNOWN_WORKERS.length}]`)}: `, (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < KNOWN_WORKERS.length) {
        resolve(KNOWN_WORKERS[idx]);
      } else {
        console.error(errorText(`Invalid selection: ${answer.trim()}`));
        process.exit(1);
      }
    });
  });
}

async function runWorker(opts: WorkerRunOptions): Promise<void> {
  // Prompt for worker name if not provided
  const name = opts.name ?? await promptWorkerSelection();

  if (!KNOWN_WORKERS.includes(name)) {
    throw new Error(
      `Unknown worker "${name}". Known workers: ${KNOWN_WORKERS.join(", ")}`
    );
  }

  // 1. Resolve the Docker build context (scope-mt-app root)
  const buildContext = opts.context
    ? resolve(opts.context)
    : findBuildContext();

  const dockerfilePath = `apps/workers/${name}/Dockerfile`;
  const fullDockerfilePath = join(buildContext, dockerfilePath);
  if (!existsSync(fullDockerfilePath)) {
    throw new Error(`Dockerfile not found: ${fullDockerfilePath}`);
  }

  // 2. Resolve scenario + persona
  console.log(`\n${banner('● Resolving scenario:')} ${value(opts.scenario)}`);
  const resolved = resolveScenarioAndPersona(
    resolve(opts.scenario),
    opts.persona ? resolve(opts.persona) : undefined,
    opts.traits ? resolve(opts.traits) : undefined
  );

  console.log(`  ${label('Task:')} ${resolved.task.substring(0, 80)}${resolved.task.length > 80 ? "..." : ""}`);
  console.log(`  ${label('Criteria:')} ${value(String(resolved.criteria.length))} item(s)`);
  if (resolved.persona) {
    console.log(`  ${label('Persona:')} ${value(resolved.persona.personality + ' ' + resolved.persona.experience)}`);
  }

  // 3. Prepare workspace
  const workspacePath = opts.workspace
    ? resolve(opts.workspace)
    : mkdtempSync(join(tmpdir(), `scope-mt-worker-${name}-`));
  console.log(`  ${label('Workspace:')} ${value(workspacePath)}`);

  // 4. Parse env file
  const envFromFile = opts.envFile ? parseEnvFile(resolve(opts.envFile)) : {};

  // 5. Build Docker image
  const docker = new Docker();
  const imageTag = `scope-mt-worker-${name}:dev`;

  console.log(`\n${banner('● Building Docker image:')} ${value(imageTag)}`);
  console.log(`  ${label('Context:')} ${dimTimestamp(buildContext)}`);
  console.log(`  ${label('Dockerfile:')} ${dimTimestamp(dockerfilePath)}`);

  await buildImage(docker, buildContext, dockerfilePath, imageTag);

  // 6. Prepare the stdin payload
  const request: DirectRunRequest = {
    task: resolved.task,
    criteria: resolved.criteria.length > 0 ? resolved.criteria : undefined,
    scenarioVersion: resolved.version,
    maxIterations: parseInt(opts.maxIterations, 10),
    judgeUrl: opts.judgeUrl,
    personaInstructions: resolved.personaInstructions,
    workspacePath: "/workspace",
  };

  // 7. Build environment variables for the container
  const containerEnv: string[] = [
    `WORKER_NAME=${name}`,
    ...Object.entries(envFromFile).map(([k, v]) => `${k}=${v}`),
  ];

  // Pass through common env vars from the host if not in env file
  const passthroughVars = [
    "GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
    "GITHUB_AUTH_STATE",
    "JUDGE_SERVICE_URL",
    "AZURE_STORAGE_ACCOUNT_NAME",
    "STORAGE_CONNECTION_STRING",
    "AZURE_STORAGE_CONNECTION_STRING",
  ];
  for (const varName of passthroughVars) {
    if (process.env[varName] && !envFromFile[varName]) {
      containerEnv.push(`${varName}=${process.env[varName]}`);
    }
  }

  // 8. Create and start container
  console.log(`\n${banner('● Running worker container...')}`);

  const container = await docker.createContainer({
    Image: imageTag,
    Cmd: ["node", "dist/direct-run.js"],
    Env: containerEnv,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Binds: [`${workspacePath}:/workspace`],
      // Add host network so container can reach local judge/azurite
      NetworkMode: "host",
    },
  });

  // Attach to the container streams
  const stream = await container.attach({
    stream: true,
    stdin: true,
    stdout: true,
    stderr: true,
    hijack: true,
  });

  // Collect stdout and stderr
  const stdoutChunks: Buffer[] = [];

  // Docker multiplexes stdout/stderr into one stream — we need to demux
  const { PassThrough } = await import("stream");
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  container.modem.demuxStream(stream, stdoutStream, stderrStream);

  stdoutStream.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });

  stderrStream.on("data", (chunk: Buffer) => {
    const lines = chunk.toString("utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      // Try to parse as JSON log event for pretty printing
      try {
        const event = JSON.parse(line);
        if (event.level && event.message) {
          const iter = event.data?.iteration ? dimTimestamp(` [iter ${event.data.iteration}]`) : "";
          console.log(`  ${colorLevel(event.level)} ${event.message}${iter}`);
          continue;
        }
      } catch { /* not JSON, print raw */ }
      console.log(`  ${dimTimestamp(line)}`);
    }
  });

  // Start the container
  await container.start();

  // Write the request to stdin, then close it
  const requestJson = JSON.stringify(request);
  stream.write(requestJson);
  stream.end();

  // Wait for container to finish
  const { StatusCode } = await container.wait();

  // Parse stdout result
  const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();

  // Clean up container
  await container.remove({ force: true });

  // Parse and display result
  if (StatusCode !== 0) {
    console.error(`\n${errorText(`✗ Worker exited with code ${StatusCode}`)}`);
    if (stdout) {
      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          console.error(`  ${errorText('Error:')} ${result.error}`);
        }
      } catch {
        console.error(`  ${label('Raw output:')} ${stdout.substring(0, 500)}`);
      }
    }
    process.exit(1);
  }

  // Parse the JSON response
  try {
    const result = JSON.parse(stdout);
    console.log(`\n${banner('● Result:')}`);
    console.log(`  ${label('Success:')} ${result.success ? successText('true') : errorText('false')}`);
    if (result.passed !== undefined) {
      console.log(`  ${label('Passed:')}  ${result.passed ? successText('true') : errorText('false')}`);
    }
    if (result.turns) {
      console.log(`  ${label('Turns:')}   ${value(String(result.turns.length))}`);
    }
    if (result.result) {
      console.log(`  ${label('Response (first 500 chars):')}`);
      console.log(`  ${dimTimestamp(result.result.substring(0, 500))}`);
    }
    console.log(`\n  ${label('Workspace:')} ${value(workspacePath)}`);
  } catch {
    console.log(`\n${banner('● Raw output:')}`);
    console.log(dimTimestamp(stdout.substring(0, 1000)));
  }
}

/**
 * Build a Docker image using dockerode, streaming build output to the console.
 */
async function buildImage(
  docker: Docker,
  contextPath: string,
  dockerfilePath: string,
  tag: string
): Promise<void> {
  // Create a tar stream of the build context
  const tarStream = tar.pack(contextPath, {
    ignore: (name: string) => {
      const rel = name.substring(contextPath.length + 1);
      // Ignore node_modules, .git, dist at root level for faster builds
      return rel === "node_modules" || rel === ".git";
    },
  });

  const buildStream = await docker.buildImage(tarStream as unknown as NodeJS.ReadableStream, {
    t: tag,
    dockerfile: dockerfilePath,
  });

  // Stream build output
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      buildStream,
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
      (event: { stream?: string; error?: string; errorDetail?: { message?: string } }) => {
        if (event.error) {
          console.error(`  ${errorText('BUILD ERROR:')} ${event.error}`);
        } else if (event.stream) {
          const line = event.stream.trimEnd();
          if (line) {
            process.stdout.write(`  ${line}\n`);
          }
        }
      }
    );
  });

  console.log(`  ${successText('✓ Image built:')} ${value(tag)}`);
}

/**
 * Auto-detect the build context by walking up from the current directory
 * looking for the monorepo root (has pnpm-workspace.yaml).
 */
function findBuildContext(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "apps", "workers"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not auto-detect build context. Run from the scope-mt-app directory or use --context."
  );
}
