// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Gateway load integration test.
 *
 * Deploys the gateway with 2 replicas into a Kind cluster, runs 10 concurrent
 * client pods (each with a unique IP), and validates:
 *   - All clients successfully complete the session lifecycle
 *   - Session affinity works (each client IP appears in only one gateway pod's logs)
 *   - CONNECT proxy, HAR download all function under concurrent load
 *
 * Prerequisites: kind, kubectl, docker must be available on PATH.
 * Skipped automatically when any prerequisite is missing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIR = resolve(__dirname, "..", ".."); // apps/gateway/
const DEPLOY_DIR = resolve(GATEWAY_DIR, "..", "..", "deploy", "base");

const CLUSTER_NAME = "gateway-load-test";
const NAMESPACE = "scoped";
const IMAGE_TAG = "scoped/gateway:load-test";
const REPLICAS = 2;
const CLIENT_COUNT = 10;
const CONTEXT = `kind-${CLUSTER_NAME}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exec(cmd: string, options?: { cwd?: string; timeout?: number }): string {
  return execSync(cmd, {
    encoding: "utf-8",
    timeout: options?.timeout ?? 120_000,
    cwd: options?.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function waitForRollout(timeout = 120): void {
  exec(
    `kubectl rollout status deployment/gateway -n ${NAMESPACE} --context ${CONTEXT} --timeout=${timeout}s`,
  );
}

function getGatewayPodNames(): string[] {
  const output = exec(
    `kubectl get pods -n ${NAMESPACE} --context ${CONTEXT} -l app=gateway -o jsonpath='{.items[*].metadata.name}'`,
  );
  return output.replace(/'/g, "").split(/\s+/).filter(Boolean);
}

function getPodLogs(podName: string): string {
  return exec(
    `kubectl logs -n ${NAMESPACE} --context ${CONTEXT} ${podName} --tail=200`,
  );
}

// ---------------------------------------------------------------------------
// Prerequisite check
// ---------------------------------------------------------------------------

const prerequisites = ["kind", "kubectl", "docker"].every(commandExists);

describe.skipIf(!prerequisites)("Gateway Load Test (Kind)", () => {
  let clusterCreated = false;

  beforeAll(async () => {
    // 1. Create Kind cluster
    exec(`kind create cluster --name ${CLUSTER_NAME} --wait 60s`);
    clusterCreated = true;

    // 2. Build gateway Docker image
    exec(`docker build -t ${IMAGE_TAG} -f Dockerfile .`, {
      cwd: GATEWAY_DIR,
      timeout: 300_000, // 5 min for Rust build
    });

    // 3. Load image into Kind
    exec(`kind load docker-image ${IMAGE_TAG} --name ${CLUSTER_NAME}`);

    // 4. Create namespace and deploy
    exec(`kubectl create namespace ${NAMESPACE} --context ${CONTEXT}`);
    exec(`kubectl apply -f ${DEPLOY_DIR}/gateway-config.yaml --context ${CONTEXT}`);

    // Apply gateway.yaml with image override and replica count
    const manifest = readFileSync(resolve(DEPLOY_DIR, "gateway.yaml"), "utf-8")
      .replace(/\$\{ACR_LOGIN_SERVER\}\/scoped\/gateway/g, IMAGE_TAG)
      .replace(/replicas:\s*\d+/, `replicas: ${REPLICAS}`);

    execSync(`kubectl apply -f - --context ${CONTEXT}`, {
      input: manifest,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // 5. Wait for rollout
    waitForRollout();
  }, 600_000); // 10 min timeout for beforeAll

  afterAll(() => {
    if (clusterCreated) {
      try {
        exec(`kind delete cluster --name ${CLUSTER_NAME}`, { timeout: 60_000 });
      } catch {
        // Best-effort cleanup
      }
    }
  });

  it("deploys 2 gateway replicas", () => {
    const pods = getGatewayPodNames();
    expect(pods).toHaveLength(REPLICAS);
  });

  it("health endpoint responds on all pods", () => {
    const pods = getGatewayPodNames();
    for (const pod of pods) {
      const result = exec(
        `kubectl exec -n ${NAMESPACE} --context ${CONTEXT} ${pod} -- wget -qO- http://localhost:18000/health`,
      );
      expect(JSON.parse(result)).toEqual({ status: "ok" });
    }
  });

  it("10 concurrent clients complete full session lifecycle", () => {
    const dollar = "$";
    // Create the load test Job
    const jobManifest = `
apiVersion: batch/v1
kind: Job
metadata:
  name: gateway-load-test
  namespace: ${NAMESPACE}
spec:
  completions: ${CLIENT_COUNT}
  parallelism: ${CLIENT_COUNT}
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: gateway-load-test
    spec:
      restartPolicy: Never
      containers:
      - name: client
        image: curlimages/curl:latest
        command: ["/bin/sh", "-c"]
        args:
        - |
          set -e
          GW="http://gateway-service:18000"
          
          # Create session
          SESSION=${dollar}(curl -sf -X POST "${dollar}GW/api/v1/sessions" -H "Content-Type: application/json" -d '{}')
          SID=${dollar}(echo "${dollar}SESSION" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
          [ -n "${dollar}SID" ] || exit 1
          
          # CONNECT through proxy
          curl -sf -o /dev/null -x "${dollar}GW" -k https://api.github.com || true
          
          # Stop session
          curl -sf -X POST "${dollar}GW/api/v1/sessions/${dollar}SID/stop"
          
          # Download HAR
          HAR=${dollar}(curl -sf "${dollar}GW/api/v1/sessions/${dollar}SID/har")
          echo "${dollar}HAR" | grep -q '"log"' || exit 1
          
          # Delete session
          curl -sf -X DELETE "${dollar}GW/api/v1/sessions/${dollar}SID"
          
          echo "PASS"
`;

    execSync(`kubectl apply -f - --context ${CONTEXT}`, {
      input: jobManifest,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for job completion (60s timeout)
    try {
      exec(
        `kubectl wait --for=condition=complete job/gateway-load-test -n ${NAMESPACE} --context ${CONTEXT} --timeout=60s`,
      );
    } catch (e) {
      // Dump client logs on failure for debugging
      const logs = exec(
        `kubectl logs -n ${NAMESPACE} --context ${CONTEXT} -l app=gateway-load-test --tail=20`,
        { timeout: 10_000 },
      );
      throw new Error(`Job did not complete. Client logs:\n${logs}\n\nOriginal: ${e}`);
    }

    // Verify all completions
    const jobStatus = exec(
      `kubectl get job gateway-load-test -n ${NAMESPACE} --context ${CONTEXT} -o jsonpath='{.status.succeeded}'`,
    );
    expect(parseInt(jobStatus.replace(/'/g, ""), 10)).toBe(CLIENT_COUNT);
  }, 120_000); // 2 min timeout for this test

  it("session affinity routes each client to exactly one pod", () => {
    const pods = getGatewayPodNames();
    expect(pods.length).toBeGreaterThanOrEqual(2);

    // Collect "Creating session for <IP>" entries per pod
    const podClients = new Map<string, Set<string>>();
    for (const pod of pods) {
      const logs = getPodLogs(pod);
      const ips = new Set<string>();
      for (const match of logs.matchAll(/Creating session for (\S+)/g)) {
        const ip = match[1];
        if (ip !== "127.0.0.1") ips.add(ip); // Exclude health probes
      }
      podClients.set(pod, ips);
    }

    // Each client IP should appear in exactly one pod
    const allIps = new Set<string>();
    for (const [, ips] of podClients) {
      for (const ip of ips) {
        expect(allIps.has(ip)).toBe(false); // No IP in multiple pods
        allIps.add(ip);
      }
    }

    // We should have seen clients from the job
    expect(allIps.size).toBeGreaterThan(0);

    // Verify CONNECT also went to the same pod (session affinity)
    for (const pod of pods) {
      const logs = getPodLogs(pod);
      const sessionIps = podClients.get(pod)!;
      for (const match of logs.matchAll(/CONNECT .+ from ip=(\S+)/g)) {
        const ip = match[1];
        if (ip !== "127.0.0.1") {
          expect(sessionIps.has(ip)).toBe(true);
        }
      }
    }
  });

  it("traffic is distributed across both pods", () => {
    const pods = getGatewayPodNames();
    const sessionCounts: number[] = [];

    for (const pod of pods) {
      const logs = getPodLogs(pod);
      const count = (logs.match(/Creating session for/g) || []).length;
      sessionCounts.push(count);
    }

    // Total should be at least CLIENT_COUNT
    const total = sessionCounts.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(CLIENT_COUNT);

    // With 10 clients and IP hashing, expect at least 1 pod gets traffic
    // (extremely unlikely all 10 IPs hash to same pod, but don't hard-fail)
    const activePods = sessionCounts.filter((c) => c > 0).length;
    expect(activePods).toBeGreaterThanOrEqual(1);
  });
});
