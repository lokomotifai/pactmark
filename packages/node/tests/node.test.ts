import { once } from "node:events";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import type { AgentFetchHandler } from "@pactmark/http";
import {
  closeNodeServer,
  createPactmarkNodeServer,
  installGracefulShutdown,
} from "../src/index.js";

const capabilities = {
  schemaVersion: "1" as const,
  executionProfile: "ephemeral" as const,
  durableStorage: false,
  protectedContext: false,
  protectedWorkOrders: false,
  protectedInputSubmissions: false,
  streaming: true,
  cancellation: true,
  sandbox: "unsafe_local" as const,
  networkPolicy: "declared" as const,
  backgroundWakeup: false,
  atomicCommandAndWakeup: false,
  humanDecisions: false,
  typedInput: false,
  effectReconciliation: false,
  compensation: false,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none" as const,
  transactionDomains: [],
};

describe("Node HTTP bridge", () => {
  it("serves Web handlers and streams request/response bodies", async () => {
    const handler: AgentFetchHandler = async (request, context) =>
      new Response(
        JSON.stringify({ body: await request.text(), binding: context.env["BINDING"] }),
        { headers: { "content-type": "application/json" } },
      );
    const server = createPactmarkNodeServer(handler, {
      capabilities,
      readEnvironment: () => ({ BINDING: "present" }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/echo`, {
      method: "POST",
      body: "hello",
    });
    expect(await response.json()).toEqual({ body: "hello", binding: "present" });
    await closeNodeServer(server);
  });

  it("returns a safe failure and validates shutdown configuration", async () => {
    const server = createPactmarkNodeServer(() => Promise.reject(new Error("secret detail")), {
      capabilities,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/failure`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret detail");
    expect(() => installGracefulShutdown(server, { timeoutMs: 0 })).toThrow(
      "KAF_NODE_SHUTDOWN_TIMEOUT_INVALID",
    );
    const uninstall = installGracefulShutdown(server, { signal: "SIGUSR2", timeoutMs: 100 });
    uninstall();
    await closeNodeServer(server);
  });

  it("aborts active handler work when the response connection closes", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markAborted: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const handler: AgentFetchHandler = async (_request, context) => {
      markStarted?.();
      await new Promise<void>((resolve) => {
        context.signal.addEventListener(
          "abort",
          () => {
            markAborted?.();
            resolve();
          },
          { once: true },
        );
      });
      return new Response(null, { status: 499 });
    };
    const server = createPactmarkNodeServer(handler, { capabilities });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const client = get(`http://127.0.0.1:${String(address.port)}/active`);
    client.on("error", () => undefined);
    await started;
    client.destroy();
    await aborted;
    await closeNodeServer(server);
  });
});
