// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import http from "node:http";

export interface NotifyHandler {
  onRunTerminal(requestId: string, runId: string): Promise<void>;
  onHandlerComplete(
    requestId: string,
    runId: string,
    handlerId: string,
    status: "done" | "failed",
  ): Promise<void>;
}

interface RunTerminalRequest {
  requestId: string;
  runId: string;
}

interface HandlerCompleteRequest {
  requestId: string;
  runId: string;
  handlerId: string;
  status: "done" | "failed";
}

function sendJson(res: http.ServerResponse, statusCode: number, body: object): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseRunTerminalRequest(body: unknown): RunTerminalRequest | null {
  if (!isRecord(body)) {
    return null;
  }

  if (!isNonEmptyString(body.requestId) || !isNonEmptyString(body.runId)) {
    return null;
  }

  return {
    requestId: body.requestId,
    runId: body.runId,
  };
}

function parseHandlerCompleteRequest(body: unknown): HandlerCompleteRequest | null {
  if (!isRecord(body)) {
    return null;
  }

  if (
    !isNonEmptyString(body.requestId) ||
    !isNonEmptyString(body.runId) ||
    !isNonEmptyString(body.handlerId) ||
    (body.status !== "done" && body.status !== "failed")
  ) {
    return null;
  }

  return {
    requestId: body.requestId,
    runId: body.runId,
    handlerId: body.handlerId,
    status: body.status,
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf-8").trim();
  if (rawBody.length === 0) {
    throw new Error("Request body is required");
  }

  return JSON.parse(rawBody) as unknown;
}

export function createHttpServer(handler: NotifyHandler): http.Server {
  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { status: "ok", service: "scheduler" });
        return;
      }

      if (method === "POST" && url.pathname === "/notify/run-terminal") {
        const parsedBody = parseRunTerminalRequest(await readJsonBody(req));
        if (!parsedBody) {
          sendJson(res, 400, { error: "requestId and runId are required" });
          return;
        }

        await handler.onRunTerminal(parsedBody.requestId, parsedBody.runId);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === "/notify/handler-complete") {
        const parsedBody = parseHandlerCompleteRequest(await readJsonBody(req));
        if (!parsedBody) {
          sendJson(res, 400, {
            error: "requestId, runId, handlerId, and status (done|failed) are required",
          });
          return;
        }

        await handler.onHandlerComplete(
          parsedBody.requestId,
          parsedBody.runId,
          parsedBody.handlerId,
          parsedBody.status,
        );
        sendJson(res, 200, { ok: true });
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      const statusCode =
        message === "Request body is required" || error instanceof SyntaxError ? 400 : 500;

      sendJson(res, statusCode, {
        error:
          statusCode === 400
            ? "Invalid JSON request body"
            : "Internal server error",
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });
}
