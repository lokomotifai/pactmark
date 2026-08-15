import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

import type { RuntimeCapabilities } from "@pactmark/core";
import type { AgentFetchHandler, AgentRuntimeContext } from "@pactmark/http";

export interface NodeHttpBridgeOptions {
  readonly publicOrigin?: string;
  readonly readEnvironment?: () => Readonly<Record<string, string | undefined>>;
  readonly capabilities: RuntimeCapabilities;
}

function requestUrl(request: IncomingMessage, publicOrigin: string | undefined): URL {
  const origin = publicOrigin ?? "http://localhost";
  return new URL(request.url ?? "/", origin);
}

function toWebRequest(
  request: IncomingMessage,
  options: NodeHttpBridgeOptions,
  signal: AbortSignal,
): Request {
  const method = request.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: new Headers(
      Object.entries(request.headers).flatMap(([name, value]) =>
        value === undefined
          ? []
          : Array.isArray(value)
            ? value.map((item) => [name, item] as [string, string])
            : [[name, value] as [string, string]],
      ),
    ),
    signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(requestUrl(request, options.publicOrigin), init);
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  target.statusMessage = response.statusText;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  if (response.body === null) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    let item = await reader.read();
    while (!item.done) {
      if (!target.write(item.value)) {
        await new Promise<void>((resolve) => target.once("drain", resolve));
      }
      item = await reader.read();
    }
    target.end();
  } catch {
    target.destroy();
  } finally {
    reader.releaseLock();
  }
}

export function createNodeRequestListener(
  handler: AgentFetchHandler,
  options: NodeHttpBridgeOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const controller = new AbortController();
    request.once("aborted", () => {
      controller.abort(new Error("client aborted request"));
    });
    response.once("close", () => {
      if (!response.writableFinished) {
        controller.abort(new Error("client disconnected"));
      }
    });
    const webRequest = toWebRequest(request, options, controller.signal);
    const context: AgentRuntimeContext = {
      env: options.readEnvironment?.() ?? {},
      signal: webRequest.signal,
      waitUntil: () => undefined,
      capabilities: options.capabilities,
    };
    void handler(webRequest, context).then(
      (webResponse) => writeResponse(webResponse, response),
      () => {
        if (!response.headersSent) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "application/problem+json");
          response.setHeader("Cache-Control", "private, no-store");
          response.end(JSON.stringify({ title: "KAF_HTTP_INTERNAL", status: 500 }));
        } else {
          response.destroy();
        }
      },
    );
  };
}

export function createPactmarkNodeServer(
  handler: AgentFetchHandler,
  options: NodeHttpBridgeOptions,
): Server {
  return createServer(createNodeRequestListener(handler, options));
}

export function closeNodeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

export function installGracefulShutdown(
  server: Server,
  options: Readonly<{ signal?: NodeJS.Signals; timeoutMs?: number }> = {},
): () => void {
  const signal = options.signal ?? "SIGTERM";
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("KAF_NODE_SHUTDOWN_TIMEOUT_INVALID");
  }
  let closing = false;
  const listener = (): void => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => {
      server.closeAllConnections();
    }, timeoutMs);
    timer.unref();
    void closeNodeServer(server).finally(() => {
      clearTimeout(timer);
    });
  };
  process.on(signal, listener);
  return () => {
    process.off(signal, listener);
  };
}
