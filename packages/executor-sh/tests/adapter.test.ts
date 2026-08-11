import { describe, expect, it } from "vitest";

import {
  digestCanonicalJson,
  type Digest,
  type JsonValue,
  type ToolRegistrationContract,
  type ToolSecurity,
} from "@pactmark/core";
import {
  MCPAdapterError,
  defineMCPServerIdentity,
  type MCPConnection,
  type MCPExposedTool,
} from "@pactmark/mcp";
import { runToolExecutorContract } from "@pactmark/testing";

import {
  ExecutorAdapterError,
  createExecutorToolExecutor,
  defineExecutorDeploymentProfile,
  defineExecutorSelfHostConformanceReceipt,
  defineExecutorToolPin,
  executorConnectionBindingDigest,
  executorRegistrationFromPin,
  verifyExecutorToolPin,
  executorSelfHostManifestDigest,
  type ExecutorToolPin,
} from "../src/index.js";

const digest = (value: string): Digest => digestCanonicalJson(value);
const executeRegistrationDigest = digest("executor-mcp-execute-registration");
const effectStrategyRegistrationDigest = digest("read-effect-strategy");
const evaluatedAt = "2026-08-11T16:30:00.000Z";

const conformanceReceipt = defineExecutorSelfHostConformanceReceipt({
  platform: "linux/arm64",
  containerRuntimeVersion: "29.3.1",
  environmentDigest: digest("executor-conformance-environment"),
  observedAt: "2026-08-11T16:00:00.000Z",
  expiresAt: "2026-08-18T15:59:59.000Z",
  checks: {
    imagePinMatched: true,
    sourceRevisionMatched: true,
    mainProcessNonRoot: true,
    readOnlyRootFilesystem: true,
    capabilitiesDropped: true,
    noNewPrivileges: true,
    resourceLimitsApplied: true,
    dedicatedDataVolume: true,
    restartPersistence: true,
    backupRestore: true,
    telemetryDisabled: true,
    analyticsIdAbsent: true,
    outboundNetworkDenied: true,
    privateNetworkDenied: true,
    stdioMcpDisabled: true,
    bootstrapCompleted: true,
    unauthenticatedMcpDenied: true,
    apiKeyMcpAuthenticated: true,
    oauthPkceAuthenticated: true,
    crossTenantCredentialDenied: true,
    credentialCanariesAbsent: true,
    executeEnvelopeMatched: true,
  },
});

const deploymentProfile = defineExecutorDeploymentProfile({
  tenantId: "tenant-a",
  executorOrigin: "https://executor.example",
  opaqueConnectionRef: "records-main",
  backupPolicyId: "executor-backup-policy",
  receipt: conformanceReceipt,
  evaluatedAt,
});

const serverIdentity = defineMCPServerIdentity({
  serverName: "executor",
  serverVersion: "1.5.40",
  serverArtifactDigest: executorSelfHostManifestDigest("linux/arm64"),
  negotiatedProtocolVersion: "2025-11-25",
  negotiatedCapabilities: { tools: {} },
  transportProfileDigest: digest("executor-transport-profile"),
});

const readSecurity: ToolSecurity = {
  schemaVersion: "1",
  riskClass: "R1",
  dataClasses: ["internal"],
  reversibility: "not_applicable",
  requiredScopes: ["records:read"],
  egress: {
    mode: "allowlist",
    destinations: ["https://api.example.com"],
    methods: ["GET"],
    credentialSlots: ["executor-connection"],
  },
  networkEnforcement: "declared_ok",
  maxCallsPerRun: 2,
  timeoutMs: 1_000,
};

const executeRegistration: ToolRegistrationContract = {
  schemaVersion: "1",
  id: "executor.execute@1",
  implementationVersion: "1.5.40",
  description: "Host-pinned Executor execute bridge",
  inputSchemaDigest: digest("execute-input"),
  outputSchemaDigest: digest("execute-output"),
  security: readSecurity,
  effectStrategyKind: "read",
  effectStrategyRegistrationDigest,
  executorKind: "mcp",
  executorVersion: "1.30.0",
  toolRegistrationDigest: executeRegistrationDigest,
};

const exposedExecute: MCPExposedTool = {
  registration: executeRegistration,
  toolName: "execute",
  serverIdentityDigest: serverIdentity.mcpServerIdentityDigest,
  pinDigest: digest("execute-pin"),
  grantId: "grant-executor-read",
};

type CallHandler = (input: JsonValue, signal: AbortSignal) => Promise<JsonValue>;

class FakeExecutorConnection implements MCPConnection {
  readonly serverIdentity = serverIdentity;
  readonly calls: Readonly<{ digest: Digest; input: JsonValue }>[] = [];
  readonly #exposedTools: readonly MCPExposedTool[];

  constructor(
    private readonly handler: CallHandler,
    exposedTools: readonly MCPExposedTool[] = [exposedExecute],
  ) {
    this.#exposedTools = exposedTools;
  }

  listExposedTools(): readonly MCPExposedTool[] {
    return this.#exposedTools;
  }

  callTool(digestValue: Digest, input: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    (this.calls as { digest: Digest; input: JsonValue }[]).push({ digest: digestValue, input });
    return this.handler(input, signal);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function toolPin(overrides: Partial<Parameters<typeof defineExecutorToolPin>[0]> = {}) {
  return defineExecutorToolPin({
    registrationId: "records.list@1",
    implementationVersion: "1.0.0",
    serverIdentityDigest: serverIdentity.mcpServerIdentityDigest,
    executeToolRegistrationDigest: executeRegistrationDigest,
    connectionBindingDigest: executorConnectionBindingDigest({
      tenantId: "tenant-a",
      executorOrigin: "https://executor.example",
      opaqueConnectionRef: "records-main",
    }),
    toolAddress: "records.org.main.rows.list",
    safeDescription: "List reviewed records",
    inputSchema: {
      type: "object",
      properties: { value: {} },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { echoed: {} },
      required: ["echoed"],
      additionalProperties: false,
    },
    security: readSecurity,
    effectStrategyRegistrationDigest,
    ...overrides,
  });
}

function create(connection: MCPConnection, pins: readonly ExecutorToolPin[] = [toolPin()]) {
  return createExecutorToolExecutor({
    connection,
    executeToolRegistrationDigest: executeRegistrationDigest,
    toolPins: pins,
    deploymentProfile,
    conformanceReceipt,
    evaluatedAt,
  });
}

describe("production-guarded Executor read adapter", () => {
  it("dispatches one generated call and never forwards a model-authored code field", async () => {
    const connection = new FakeExecutorConnection(() =>
      Promise.resolve({ status: "completed", result: { echoed: "ok" }, logs: [] }),
    );
    const executor = create(connection);
    const registration = executor.listRegistrations()[0]!;
    await expect(
      executor.execute({
        registration,
        input: { value: '" ); globalThis.compromised = true; //' },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ echoed: "ok" });

    expect(connection.calls).toHaveLength(1);
    expect(connection.calls[0]?.digest).toBe(executeRegistrationDigest);
    expect(connection.calls[0]?.input).toEqual({
      code: [
        String.raw`const input = JSON.parse("{\"value\":\"\\\" ); globalThis.compromised = true; //\"}");`,
        'return await tools["records.org.main.rows.list"](input);',
      ].join("\n"),
    });
    expect(executor.capabilities).toMatchObject({
      sandbox: "unsafe_local",
      networkPolicy: "declared",
      toolCredentials: true,
      telemetry: "none",
    });
  });

  it("passes the shared ToolExecutor conformance contract with safe errors", async () => {
    const sensitiveErrorMarker = "executor-upstream-secret-canary";
    const connection = new FakeExecutorConnection((input) => {
      const code = (input as { readonly code: string }).code;
      if (code.includes("malformed-output")) {
        return Promise.resolve({ status: "completed", result: 42, logs: [] });
      }
      if (code.includes("failure")) {
        return Promise.reject(new Error(`${sensitiveErrorMarker}: upstream rejected`));
      }
      return Promise.resolve({ status: "completed", result: { echoed: { value: 1 } }, logs: [] });
    });
    const executor = create(connection);
    const registeredTool = executor.listRegistrations()[0]!;
    const report = await runToolExecutorContract(() => ({
      executor,
      registeredTool,
      unknownTool: {
        ...registeredTool,
        id: "records.unknown@1",
        toolRegistrationDigest: digest("unknown-executor-registration"),
      },
      input: { value: 1 },
      expectedOutput: { echoed: { value: 1 } },
      malformedOutputInput: { value: "malformed-output" },
      failureInput: { value: "failure" },
      sensitiveErrorMarker,
      errorSurface: (error) => ({
        code: error instanceof ExecutorAdapterError ? error.code : "KAF_EXECUTOR_UNKNOWN",
        message: error instanceof Error ? error.message : "unknown",
      }),
      dispatchCount: () => connection.calls.length,
    }));
    expect(report.suite).toBe("ToolExecutor");
  });

  it("rejects pin, server, execute-tool, and duplicate drift before dispatch", () => {
    const pin = toolPin();
    expect(() => verifyExecutorToolPin({} as ExecutorToolPin)).toThrow(
      expect.objectContaining({ code: "KAF_EXECUTOR_PIN_DRIFT" }),
    );
    expect(() =>
      verifyExecutorToolPin({ ...pin, toolAddress: "records.org.other.rows.list" }),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_PIN_DRIFT" }));

    const connection = new FakeExecutorConnection(() => Promise.resolve(null));
    expect(() => create(connection, [])).toThrow(
      expect.objectContaining({ code: "KAF_EXECUTOR_PIN_DRIFT" }),
    );
    expect(() => create(connection, [pin, pin])).toThrow(
      expect.objectContaining({ code: "KAF_EXECUTOR_PIN_DRIFT" }),
    );
    expect(() =>
      createExecutorToolExecutor({
        connection,
        executeToolRegistrationDigest: digest("different-execute"),
        toolPins: [pin],
        deploymentProfile,
        conformanceReceipt,
        evaluatedAt,
      }),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_CONNECTION_DRIFT" }));
    expect(() =>
      create(connection, [toolPin({ serverIdentityDigest: digest("other-executor-server") })]),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_CONNECTION_DRIFT" }));
    expect(() =>
      create(connection, [
        toolPin({
          connectionBindingDigest: executorConnectionBindingDigest({
            tenantId: "tenant-b",
            executorOrigin: "https://executor.example",
            opaqueConnectionRef: "records-main",
          }),
        }),
      ]),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_CONNECTION_DRIFT" }));
    expect(() =>
      create(new FakeExecutorConnection(() => Promise.resolve(null), []), [pin]),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_CONNECTION_DRIFT" }));
    expect(connection.calls).toHaveLength(0);
  });

  it("refuses write-risk, required-enforcement, no-egress, and invalid-schema pins", () => {
    expect(() => toolPin({ security: { ...readSecurity, riskClass: "R2" } })).toThrow(
      expect.objectContaining({ code: "KAF_EXECUTOR_POLICY_UNSUPPORTED" }),
    );
    expect(() =>
      toolPin({ security: { ...readSecurity, networkEnforcement: "required" } }),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_POLICY_UNSUPPORTED" }));
    expect(() => toolPin({ security: { ...readSecurity, egress: { mode: "none" } } })).toThrow(
      expect.objectContaining({ code: "KAF_EXECUTOR_POLICY_UNSUPPORTED" }),
    );

    const invalidSchemaPin = toolPin({ outputSchema: { type: "not-a-json-schema-type" } });
    expect(() =>
      create(new FakeExecutorConnection(() => Promise.resolve(null)), [invalidSchemaPin]),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_SCHEMA_INVALID" }));

    expect(() =>
      create(new FakeExecutorConnection(() => Promise.resolve(null)), [
        toolPin({ inputSchema: {} }),
      ]),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_SCHEMA_UNSAFE" }));
  });

  it("validates the pinned upstream input schema before calling Executor", async () => {
    const connection = new FakeExecutorConnection(() =>
      Promise.resolve({ status: "completed", result: { echoed: "ok" }, logs: [] }),
    );
    const executor = create(connection, [
      toolPin({
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      }),
    ]);
    await expect(
      executor.execute({
        registration: executor.listRegistrations()[0]!,
        input: { unreviewed: true },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "KAF_EXECUTOR_INPUT_INVALID" });
    expect(connection.calls).toHaveLength(0);
  });

  it("rejects paused and malformed envelopes without attempting resume", async () => {
    const paused = new FakeExecutorConnection(() =>
      Promise.resolve({ status: "paused", executionId: "execution-a" }),
    );
    const pausedExecutor = create(paused);
    await expect(
      pausedExecutor.execute({
        registration: pausedExecutor.listRegistrations()[0]!,
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "KAF_EXECUTOR_STATUS_UNSUPPORTED" });
    expect(paused.calls).toHaveLength(1);

    const malformed = new FakeExecutorConnection(() =>
      Promise.resolve({ status: "completed", logs: [] }),
    );
    const malformedExecutor = create(malformed);
    await expect(
      malformedExecutor.execute({
        registration: malformedExecutor.listRegistrations()[0]!,
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "KAF_EXECUTOR_OUTPUT_INVALID" });
  });

  it("enforces the pinned tool timeout even when the connection does not settle", async () => {
    const connection = new FakeExecutorConnection(() => new Promise(() => undefined));
    const executor = create(connection, [
      toolPin({ security: { ...readSecurity, timeoutMs: 10 } }),
    ]);
    await expect(
      executor.execute({
        registration: executor.listRegistrations()[0]!,
        input: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "KAF_EXECUTOR_TIMEOUT" });
    expect(
      executor.classifyError?.(
        new ExecutorAdapterError("KAF_EXECUTOR_TIMEOUT", "safe"),
        executor.listRegistrations()[0]!,
      ),
    ).toBe("retryable");
  });

  it("propagates in-flight cancellation as a stable safe code", async () => {
    const connection = new FakeExecutorConnection(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("sensitive abort reason"));
            },
            { once: true },
          );
        }),
    );
    const executor = create(connection);
    const controller = new AbortController();
    const pending = executor.execute({
      registration: executor.listRegistrations()[0]!,
      input: {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "KAF_EXECUTOR_ABORTED" });
    expect(
      executor.classifyError?.(
        new ExecutorAdapterError("KAF_EXECUTOR_ABORTED", "safe"),
        executor.listRegistrations()[0]!,
      ),
    ).toBe("aborted");
    expect(
      executor.classifyError?.(
        new ExecutorAdapterError("KAF_EXECUTOR_CONNECTION_FAILED", "safe"),
        executor.listRegistrations()[0]!,
      ),
    ).toBe("retryable");
    expect(
      executor.classifyError?.(
        new ExecutorAdapterError("KAF_EXECUTOR_OUTPUT_INVALID", "safe"),
        executor.listRegistrations()[0]!,
      ),
    ).toBe("non_retryable");
    expect(executor.classifyError?.(new Error("unknown"), executor.listRegistrations()[0]!)).toBe(
      "non_retryable",
    );
  });

  it("sanitizes MCP failures and validates tenant-bound HTTPS connection references", async () => {
    const connection = new FakeExecutorConnection(() =>
      Promise.reject(
        new MCPAdapterError("KAF_MCP_CONNECTION_FAILED", "secret bearer token appeared here"),
      ),
    );
    const executor = create(connection);
    const failure = executor.execute({
      registration: executor.listRegistrations()[0]!,
      input: {},
      signal: new AbortController().signal,
    });
    await expect(failure).rejects.toMatchObject({
      code: "KAF_EXECUTOR_CONNECTION_FAILED",
      message: "The pinned Executor MCP call failed",
    });
    await expect(failure).rejects.not.toThrow("secret bearer token");

    expect(() =>
      executorConnectionBindingDigest({
        tenantId: "tenant-a",
        executorOrigin: "http://executor.example",
        opaqueConnectionRef: "records-main",
      }),
    ).toThrow("KAF_EXECUTOR_ORIGIN_INVALID");
    expect(executorRegistrationFromPin(toolPin()).toolRegistrationDigest).toBe(
      toolPin().toolRegistrationDigest,
    );
  });
});
