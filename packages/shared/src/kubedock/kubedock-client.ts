// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import http from "node:http";

/**
 * HTTP client for the kubedock Docker-compatible API.
 *
 * Kubedock exposes a standard Docker API over a Unix socket. This client
 * provides cleanup operations (list + remove containers) used in worker
 * setup/teardown to prevent inter-run leakage.
 *
 * Reads DOCKER_HOST from env. Use KubedockClient.isEnabled() to check
 * if kubedock is configured before creating an instance.
 */
export class KubedockClient {
  private readonly socketPath: string;

  constructor(dockerHost?: string) {
    const host = dockerHost ?? process.env.DOCKER_HOST ?? "";
    // Parse unix:///path/to/socket format
    this.socketPath = host.replace(/^unix:\/\//, "");
  }

  /**
   * Returns true when kubedock is the Docker backend.
   *
   * Requires both DOCKER_HOST (unix socket) and KUBEDOCK_ENABLED=true.
   * In Docker Compose the host socket is mounted directly — cleanup must
   * NOT run there because purgeContainers would kill the entire stack.
   */
  static isEnabled(): boolean {
    const host = process.env.DOCKER_HOST ?? "";
    return host.startsWith("unix://") && process.env.KUBEDOCK_ENABLED === "true";
  }

  /** List all container IDs (including stopped) */
  async listContainers(): Promise<string[]> {
    const data = await this.request<Array<{ Id: string }>>(
      "GET",
      "/containers/json?all=true",
    );
    return data.map((c) => c.Id);
  }

  /** Force-remove a container by ID (ignores 404) */
  async removeContainer(id: string): Promise<void> {
    try {
      await this.request("DELETE", `/containers/${id}?force=true`);
    } catch (err) {
      if (err instanceof KubedockError && err.statusCode === 404) return;
      throw err;
    }
  }

  /** Remove all containers — used in setup for crash recovery */
  async purgeContainers(): Promise<number> {
    const ids = await this.listContainers();
    await Promise.all(ids.map((id) => this.removeContainer(id)));
    return ids.length;
  }

  private request<T = unknown>(method: string, path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString();
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(body ? (JSON.parse(body) as T) : (undefined as unknown as T));
            } else {
              reject(new KubedockError(method, path, res.statusCode ?? 0, body));
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
}

export class KubedockError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly statusCode: number,
    public readonly body: string,
  ) {
    super(`[KubedockClient] ${method} ${path} failed: ${statusCode} ${body}`);
    this.name = "KubedockError";
  }
}
