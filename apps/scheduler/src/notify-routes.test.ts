// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpServer, type NotifyHandler } from "./notify-routes.js";

async function startServer(handler: NotifyHandler): Promise<{ server: ReturnType<typeof createHttpServer>; baseUrl: string }> {
  const server = createHttpServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to an address");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
  };
}

async function stopServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("createHttpServer", () => {
  const servers: Array<ReturnType<typeof createHttpServer>> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await stopServer(server);
      }
    }
  });

  it("returns 200 for the health endpoint", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "scheduler" });
  });

  it("calls onRunTerminal for valid run-terminal notifications", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const response = await fetch(`${baseUrl}/notify/run-terminal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-1", runId: "run-1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(handler.onRunTerminal).toHaveBeenCalledWith("req-1", "run-1");
    expect(handler.onHandlerComplete).not.toHaveBeenCalled();
  });

  it("calls onHandlerComplete for valid handler-complete notifications", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const response = await fetch(`${baseUrl}/notify/handler-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-1",
        runId: "run-1",
        handlerId: "atif",
        status: "done",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(handler.onHandlerComplete).toHaveBeenCalledWith("req-1", "run-1", "atif", "done");
    expect(handler.onRunTerminal).not.toHaveBeenCalled();
  });

  it("returns 400 when required fields are missing", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const response = await fetch(`${baseUrl}/notify/handler-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-1", runId: "run-1", status: "done" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "requestId, runId, handlerId, and status (done|failed) are required",
    });
    expect(handler.onRunTerminal).not.toHaveBeenCalled();
    expect(handler.onHandlerComplete).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown routes", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const response = await fetch(`${baseUrl}/notify/unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("calls registerHandler for valid handler registrations", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const doc = {
      _id: "pp-example",
      type: "post-process-handler",
      version: 1,
      queue: "pp-example-queue",
      selector: "example",
      autoBackfill: false,
      dependsOn: ["pp-atif"],
    };

    const response = await fetch(`${baseUrl}/handlers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, handlerId: "pp-example" });
    expect(handler.registerHandler).toHaveBeenCalledWith(doc);
  });

  it("returns 400 for invalid handler registrations", async () => {
    const handler: NotifyHandler = {
      onRunTerminal: vi.fn().mockResolvedValue(undefined),
      onHandlerComplete: vi.fn().mockResolvedValue(undefined),
      registerHandler: vi.fn().mockResolvedValue(undefined),
    };
    const { server, baseUrl } = await startServer(handler);
    servers.push(server);

    const response = await fetch(`${baseUrl}/handlers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Missing queue/selector, wrong type, dependsOn not array
      body: JSON.stringify({ _id: "bad", type: "wrong", version: "x" }),
    });

    expect(response.status).toBe(400);
    expect(handler.registerHandler).not.toHaveBeenCalled();
  });
});
