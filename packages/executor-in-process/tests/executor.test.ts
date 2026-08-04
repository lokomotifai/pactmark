import { describe, expect, it, vi } from "vitest";

import { digestCanonicalJson, type JsonValue, type ToolRegistrationContract } from "@pactmark/core";
import { runEgressBrokerContract, runToolExecutorContract } from "@pactmark/testing";

import {
  createDeclaredAllowlistEgressBroker,
  createDeclaredToolExecutor,
  createDenyAllEgressBroker,
} from "../src/index.js";

const digest = digestCanonicalJson("registration");
const registration: ToolRegistrationContract = {
  schemaVersion: "1",
  id: "fixture.read@1",
  implementationVersion: "1.0.0",
  description: "Read a deterministic fixture",
  inputSchemaDigest: digest,
  outputSchemaDigest: digest,
  security: {
    schemaVersion: "1",
    riskClass: "R1",
    dataClasses: ["public"],
    reversibility: "not_applicable",
    requiredScopes: ["fixture:read"],
    egress: { mode: "none" },
    networkEnforcement: "declared_ok",
    maxCallsPerRun: 1,
    timeoutMs: 1_000,
  },
  effectStrategyKind: "read",
  effectStrategyRegistrationDigest: digest,
  executorKind: "in-process",
  executorVersion: "1",
  toolRegistrationDigest: digest,
};

describe("declared in-process boundaries", () => {
  it("executes only an exact host-declared registration", async () => {
    const execute = vi.fn((input: JsonValue) => Promise.resolve(input));
    const executor = createDeclaredToolExecutor([{ registration, execute }]);
    await expect(
      executor.execute({ registration, input: { value: 1 }, signal: new AbortController().signal }),
    ).resolves.toEqual({ value: 1 });
    expect(execute).toHaveBeenCalledOnce();
    await expect(
      executor.execute({
        registration: { ...registration, toolRegistrationDigest: digestCanonicalJson("other") },
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("KAF_TOOL_NOT_DECLARED");
    expect(executor.networkPolicy).toBe("declared");
    expect(executor.capabilities.sandbox).toBe("unsafe_local");
  });

  it("rejects duplicate registration drift and aborted calls", async () => {
    expect(() =>
      createDeclaredToolExecutor([
        { registration, execute: () => Promise.resolve(null) },
        {
          registration: { ...registration, toolRegistrationDigest: digestCanonicalJson("other") },
          execute: () => Promise.resolve(null),
        },
      ]),
    ).toThrow("KAF_REGISTRATION_SAME_VERSION_DRIFT");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      createDeclaredToolExecutor([{ registration, execute: () => Promise.resolve(null) }]).execute({
        registration,
        input: null,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");

    const executor = createDeclaredToolExecutor([
      { registration, execute: () => Promise.resolve(null) },
    ]);
    await expect(
      executor.execute({
        registration: { ...registration, implementationVersion: "2.0.0" },
        input: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("KAF_TOOL_NOT_DECLARED");
    await expect(
      executor.execute({
        registration: { ...registration, id: "fixture.other@1" },
        input: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("KAF_TOOL_NOT_DECLARED");
  });

  it("denies all egress by default", async () => {
    const broker = createDenyAllEgressBroker();
    const client = broker.bind({
      tenantId: "tenant",
      runId: "run",
      toolRegistrationDigest: digest,
    });
    await expect(client.fetch("https://example.com")).rejects.toThrow("KAF_EGRESS_DENIED");
    expect(broker.capabilities.networkPolicy).toBe("none");
  });

  it("permits only declared origin/method and forces manual redirects", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response("ok", { status: 200 })));
    const broker = createDeclaredAllowlistEgressBroker({
      allowedOrigins: ["https://example.com"],
      allowedMethods: ["GET"],
      fetch,
    });
    const client = broker.bind({
      tenantId: "tenant",
      runId: "run",
      toolRegistrationDigest: digest,
    });
    await expect(client.fetch("https://example.com/data")).resolves.toHaveProperty("status", 200);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ redirect: "manual" }),
    );
    await expect(client.fetch("https://other.example/data")).rejects.toThrow("KAF_EGRESS_DENIED");
    await expect(client.fetch("https://example.com/data", { method: "POST" })).rejects.toThrow(
      "KAF_EGRESS_DENIED",
    );
    expect(() => createDeclaredAllowlistEgressBroker({ allowedOrigins: [], fetch })).toThrow(
      "KAF_EGRESS_ALLOWLIST_EMPTY",
    );
    expect(() =>
      createDeclaredAllowlistEgressBroker({
        allowedOrigins: ["http://example.com"],
        fetch,
      }),
    ).toThrow("KAF_EGRESS_ORIGIN_INVALID");
    expect(() =>
      createDeclaredAllowlistEgressBroker({
        allowedOrigins: ["https://user@example.com"],
        fetch,
      }),
    ).toThrow("KAF_EGRESS_ORIGIN_INVALID");
    expect(() =>
      createDeclaredAllowlistEgressBroker({
        allowedOrigins: ["https://example.com/path"],
        fetch,
      }),
    ).toThrow("KAF_EGRESS_ORIGIN_INVALID");
    expect(() =>
      createDeclaredAllowlistEgressBroker({
        allowedOrigins: ["https://example.com"],
        allowedMethods: [],
        fetch,
      }),
    ).toThrow("KAF_EGRESS_METHOD_ALLOWLIST_EMPTY");

    const developmentBroker = createDeclaredAllowlistEgressBroker({
      allowedOrigins: ["http://127.0.0.1:8787"],
      allowLoopbackHttpForDevelopment: true,
      fetch,
    });
    await expect(
      developmentBroker
        .bind({ tenantId: "tenant", runId: "run", toolRegistrationDigest: digest })
        .fetch("http://127.0.0.1:8787/health", { method: "HEAD" }),
    ).resolves.toHaveProperty("status", 200);
  });
});

describe("published conformance contracts", () => {
  it("passes the ToolExecutor contract", async () => {
    const sensitiveErrorMarker = "executor-secret-canary";
    let dispatches = 0;
    const executor = createDeclaredToolExecutor([
      {
        registration,
        execute(input) {
          dispatches += 1;
          if (input === "malformed-output") return Promise.resolve(undefined as never);
          if (input === "failure") {
            return Promise.reject(new Error(`${sensitiveErrorMarker}: upstream failed`));
          }
          return Promise.resolve({ echoed: input });
        },
      },
    ]);
    const report = await runToolExecutorContract(() => ({
      executor,
      registeredTool: registration,
      unknownTool: {
        ...registration,
        id: "fixture.unknown@1",
        toolRegistrationDigest: digestCanonicalJson("unknown-registration"),
      },
      input: { value: 1 },
      expectedOutput: { echoed: { value: 1 } },
      malformedOutputInput: "malformed-output",
      failureInput: "failure",
      sensitiveErrorMarker,
      errorSurface: (error) => ({
        code:
          error instanceof Error && /^KAF_[A-Z0-9_]+$/u.test(error.message)
            ? error.message
            : "KAF_TOOL_EXECUTION_FAILED",
      }),
      dispatchCount: () => dispatches,
    }));
    expect(report.suite).toBe("ToolExecutor");
  });

  it("passes the declared EgressBroker contract", async () => {
    const sensitiveErrorMarker = "egress-secret-canary";
    let transports = 0;
    const broker = createDeclaredAllowlistEgressBroker({
      allowedOrigins: ["https://allowed.example"],
      fetch: () => {
        transports += 1;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    const report = await runEgressBrokerContract(() => ({
      broker,
      binding: { tenantId: "tenant-a", runId: "run-a", toolRegistrationDigest: digest },
      crossTenantBinding: {
        tenantId: "tenant-b",
        runId: "run-a",
        toolRegistrationDigest: digest,
      },
      allowed: { request: new Request("https://allowed.example/read"), expectedStatus: 204 },
      denied: { request: new Request("https://denied.example/read") },
      crossTenantDenied: { request: new Request("https://denied.example/tenant-a") },
      abortRequest: new Request("https://allowed.example/read"),
      sensitiveErrorMarker,
      errorSurface: (error) => ({
        code:
          error instanceof Error && /^KAF_[A-Z0-9_]+$/u.test(error.message)
            ? error.message
            : "KAF_EGRESS_FAILED",
      }),
      transportCallCount: () => transports,
    }));
    expect(report.suite).toBe("EgressBroker");
  });
});
