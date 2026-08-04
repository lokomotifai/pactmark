import {
  createCommandContext,
  digestCanonicalJson,
  JsonValueSchema,
  RuntimeCapabilitiesSchema,
  type CommandScope,
  type EgressBroker,
} from "@pactmark/core";
import {
  createMemoryStoreSuite,
  MemoryAcceptedWorkOrderStore,
  MemoryArtifactStore,
  MemoryContextStore,
  MemoryEventStore,
  MemoryInputSubmissionStore,
  MemoryRunLeaseStore,
} from "@pactmark/store-memory";
import { describe, expect, it } from "vitest";

import {
  CrashInjectedError,
  CrashInjector,
  ENFORCED_EGRESS_PROBES,
  FakeClock,
  FakeInvocationError,
  FakeModelDriver,
  FakeTool,
  FakeToolExecutor,
  ScenarioBuilder,
  SequenceIdGenerator,
  crashAtEveryBoundary,
  createFakeToolRegistration,
  runAcceptedWorkOrderStoreContract,
  runArtifactStoreContract,
  runContextStoreContract,
  runEgressBrokerContract,
  runEnforcedEgressContract,
  runEventStoreContract,
  runInputSubmissionStoreContract,
  runMCPUntrustedToolAdapterContract,
  runRunLeaseStoreContract,
  runRunCommandUnitOfWorkContract,
  runStoreContracts,
  runToolExecutorContract,
} from "../src/index.js";
import type { ContractViolation } from "../src/index.js";

describe("deterministic primitives", () => {
  it("advances wall and monotonic time and releases sleepers without host time", async () => {
    const clock = new FakeClock({ now: "2026-08-03T10:00:00.000Z", monotonicMilliseconds: 40 });
    const waiting = clock.sleep(100);
    expect(clock.pendingSleeps()).toBe(1);
    clock.advance(99);
    expect(clock.pendingSleeps()).toBe(1);
    clock.advance(1);
    await expect(waiting).resolves.toBeUndefined();
    expect(clock.now()).toBe("2026-08-03T10:00:00.100Z");
    expect(clock.monotonicMilliseconds()).toBe(140);
  });

  it("rejects cancelled sleeps and refuses time travel", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const waiting = clock.sleep(100, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(clock.pendingSleeps()).toBe(0);
    expect(() => {
      clock.setWallTime("2025-01-01T00:00:00.000Z");
    }).toThrow("backwards");
  });

  it("produces one global deterministic ID sequence", () => {
    const ids = new SequenceIdGenerator({ prefix: "case", startAt: 8, width: 3 });
    expect(ids.generate("run")).toBe("case-run-009");
    expect(ids.generate("event")).toBe("case-event-010");
    expect(ids.currentSequence()).toBe(10);
    expect(() => ids.generate("bad kind")).toThrow("unsupported");
    const exhausted = new SequenceIdGenerator({ startAt: Number.MAX_SAFE_INTEGER });
    expect(() => exhausted.generate("run")).toThrow("exhausted");
  });

  it("crashes only at configured boundary occurrences", () => {
    const crashes = new CrashInjector([{ boundary: "event.after", occurrence: 2 }]);
    crashes.hit("event.after");
    expect(() => {
      crashes.hit("event.after");
    }).toThrow(CrashInjectedError);
    expect(crashes.hitCount("event.after")).toBe(2);
    expect(crashes.snapshot()).toEqual({ "event.after": 2 });
    expect(crashAtEveryBoundary(["before", "after"])).toHaveLength(2);
    expect(() => new CrashInjector([{ boundary: "", occurrence: 1 }])).toThrow("required");
    expect(() => new CrashInjector([{ boundary: "event", occurrence: 0 }])).toThrow(
      "positive integer",
    );
  });
});

describe("scripted model and tools", () => {
  const run = {
    schemaVersion: "1" as const,
    runId: "run-1",
    tenantId: "tenant-1",
    workOrderId: "work-1",
    workOrderBindingDigest: digestCanonicalJson({ work: 1 }),
    executionDefinition: {
      kind: "agent" as const,
      id: "agent",
      version: "1.0.0",
      agentDefinitionDigest: digestCanonicalJson({ agent: 1 }),
    },
    executionDefinitionDigest: digestCanonicalJson({ execution: 1 }),
    status: "planning" as const,
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z",
    dataClass: "internal" as const,
    correlationId: "correlation-1",
  };

  it("consumes model turns once, clones observations, and fails when exhausted", async () => {
    const model = new FakeModelDriver({
      turns: [{ chunks: [{ type: "text", value: { answer: 42 } }] }],
    });
    const chunks = [];
    for await (const chunk of model.invoke({
      run,
      input: { prompt: "answer" },
      signal: new AbortController().signal,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ type: "text", value: { answer: 42 } }]);
    expect(model.invocations()).toHaveLength(1);
    expect(model.remainingTurns()).toBe(0);
    await expect(
      collect(model.invoke({ run, input: null, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: "KAF_TESTING_MODEL_SCRIPT_EXHAUSTED" });
  });

  it("dispatches only an exact fake tool registration and propagates cancellation", async () => {
    const registration = createFakeToolRegistration();
    const tool = new FakeTool({ registration, handler: (input) => ({ echoed: input }) });
    const executor = new FakeToolExecutor({ tools: [tool] });
    await expect(
      executor.execute({
        registration,
        input: "hello",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ echoed: "hello" });
    expect(tool.calls()).toEqual([{ index: 0, input: "hello" }]);
    await expect(
      executor.execute({
        registration: createFakeToolRegistration({ id: "testing.unknown@1" }),
        input: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(FakeInvocationError);

    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      executor.execute({ registration, input: null, signal: controller.signal }),
    ).rejects.toThrow("stop");
    expect(tool.calls()).toHaveLength(1);
    expect(() => {
      executor.register(tool);
    }).toThrow("KAF_TESTING_TOOL_ALREADY_REGISTERED");
    expect(
      () =>
        new FakeToolExecutor({
          capabilities: { ...executor.capabilities, networkPolicy: "declared" },
        }),
    ).toThrow("KAF_TESTING_NETWORK_POLICY_MISMATCH");
  });

  it("assembles independent scenarios with shared crash boundaries", async () => {
    const builder = new ScenarioBuilder()
      .at("2026-08-03T10:00:00Z")
      .withIdPrefix("matrix")
      .modelTurn({ type: "text", value: "done" })
      .echoTool()
      .crashAt("tool.before_execute");
    const first = builder.build();
    const second = builder.build();
    expect(first.clock.now()).toBe("2026-08-03T10:00:00.000Z");
    expect(first.ids.generate("run")).toBe("matrix-run-000001");
    await expect(
      first.toolExecutor.execute({
        registration: first.tools[0]!.registration,
        input: { value: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CrashInjectedError);
    expect(second.crashes.hitCount("tool.before_execute")).toBe(0);
  });
});

describe("reusable contracts", () => {
  it("passes every memory store contract", async () => {
    const reports = await runStoreContracts({
      createAcceptedWorkOrderStore: () => new MemoryAcceptedWorkOrderStore(),
      createInputSubmissionStore: () => new MemoryInputSubmissionStore(),
      createEventStore: () => new MemoryEventStore(),
      createContextStore: () => new MemoryContextStore(),
      createArtifactStore: () => new MemoryArtifactStore(),
      createRunLeaseHarness: () => {
        const clock = new FakeClock();
        return {
          store: new MemoryRunLeaseStore({ now: () => clock.now() }),
          advance: (milliseconds) => {
            clock.advance(milliseconds);
          },
        };
      },
    });
    expect(reports).toHaveLength(6);
    expect(reports.every((report) => report.passedChecks.length >= 3)).toBe(true);
  });

  it("reports a stable contract violation when a harness violates an invariant", async () => {
    const registered = createFakeToolRegistration();
    const unknown = createFakeToolRegistration({ id: "testing.unknown@1" });
    const tool = new FakeTool({ registration: registered });
    await expect(
      runToolExecutorContract(() => ({
        executor: new FakeToolExecutor({ tools: [tool] }),
        registeredTool: registered,
        unknownTool: unknown,
        input: null,
        expectedOutput: { deliberately: "wrong" },
        malformedOutputInput: { malformed: true },
        failureInput: { fail: true },
        sensitiveErrorMarker: "contract-secret",
        errorSurface: () => ({ code: "KAF_TESTING_TOOL_FAILURE", message: "safe" }),
        dispatchCount: () => tool.calls().length,
      })),
    ).rejects.toMatchObject({
      name: "ContractViolation",
      suite: "ToolExecutor",
      check: "registered-tool-result",
    } satisfies Partial<ContractViolation>);
  });

  it("passes each individually exported store contract and lease fencing suite", async () => {
    await expect(
      runAcceptedWorkOrderStoreContract(() => new MemoryAcceptedWorkOrderStore()),
    ).resolves.toMatchObject({ suite: "AcceptedWorkOrderStore" });
    await expect(
      runInputSubmissionStoreContract(() => new MemoryInputSubmissionStore()),
    ).resolves.toMatchObject({ suite: "InputSubmissionStore" });
    await expect(runEventStoreContract(() => new MemoryEventStore())).resolves.toMatchObject({
      suite: "EventStore",
    });
    await expect(runContextStoreContract(() => new MemoryContextStore())).resolves.toMatchObject({
      suite: "ContextStore",
    });
    await expect(runArtifactStoreContract(() => new MemoryArtifactStore())).resolves.toMatchObject({
      suite: "ArtifactStore",
    });

    const clock = new FakeClock();
    await expect(
      runRunLeaseStoreContract(() => ({
        store: new MemoryRunLeaseStore({ now: () => clock.now() }),
        advance: (milliseconds) => {
          clock.advance(milliseconds);
        },
      })),
    ).resolves.toMatchObject({ suite: "RunLeaseStore" });
  });

  it("passes the fake tool executor contract", async () => {
    const registered = createFakeToolRegistration();
    const unknown = createFakeToolRegistration({ id: "testing.unknown@1" });
    const sensitiveErrorMarker = "tool-contract-sensitive-value";
    const tool = new FakeTool({
      registration: registered,
      handler: (input) => {
        if (isJsonRecord(input) && input["fail"]) {
          throw new Error(sensitiveErrorMarker);
        }
        if (isJsonRecord(input) && input["malformed"]) return undefined as never;
        return { ok: true };
      },
    });
    await expect(
      runToolExecutorContract(() => ({
        executor: new FakeToolExecutor({ tools: [tool] }),
        registeredTool: registered,
        unknownTool: unknown,
        input: { value: 1 },
        expectedOutput: { ok: true },
        malformedOutputInput: { malformed: true },
        failureInput: { fail: true },
        sensitiveErrorMarker,
        errorSurface: () => ({ code: "KAF_TESTING_TOOL_FAILURE", message: "Tool failed" }),
        dispatchCount: () => tool.calls().length,
      })),
    ).resolves.toMatchObject({ suite: "ToolExecutor" });
  });

  it("checks declared egress and every enforced bypass probe", async () => {
    let transportCalls = 0;
    const capabilities = RuntimeCapabilitiesSchema.parse({
      schemaVersion: "1",
      executionProfile: "ephemeral",
      durableStorage: false,
      protectedContext: false,
      protectedWorkOrders: false,
      protectedInputSubmissions: false,
      streaming: false,
      cancellation: true,
      sandbox: "isolated",
      networkPolicy: "declared",
      backgroundWakeup: false,
      atomicCommandAndWakeup: false,
      humanDecisions: false,
      typedInput: false,
      effectReconciliation: false,
      compensation: false,
      modelCredentials: false,
      toolCredentials: false,
      telemetry: "none",
      transactionDomains: ["testing"],
    });
    const sensitiveErrorMarker = "egress-contract-sensitive-value";
    const broker: EgressBroker = {
      capabilities,
      bind: (binding) => ({
        fetch: async (input, init) => {
          await Promise.resolve();
          if (init?.signal?.aborted) throw new Error("aborted");
          if (binding.tenantId !== "tenant") throw new Error("cross tenant denied");
          const request = new Request(input);
          if (new URL(request.url).origin !== "https://allowed.example") {
            throw new Error("denied");
          }
          transportCalls += 1;
          return new Response(null, { status: 204 });
        },
      }),
    };
    await expect(
      runEgressBrokerContract(() => ({
        broker,
        binding: {
          tenantId: "tenant",
          runId: "run",
          toolRegistrationDigest: digestCanonicalJson({ tool: 1 }),
        },
        crossTenantBinding: {
          tenantId: "other-tenant",
          runId: "run",
          toolRegistrationDigest: digestCanonicalJson({ tool: 1 }),
        },
        allowed: { request: new Request("https://allowed.example/read"), expectedStatus: 204 },
        denied: {
          request: new Request(`https://denied.example/read?token=${sensitiveErrorMarker}`),
        },
        crossTenantDenied: { request: new Request("https://allowed.example/read") },
        abortRequest: new Request("https://allowed.example/read"),
        sensitiveErrorMarker,
        errorSurface: () => ({ code: "KAF_TESTING_EGRESS_DENIED", message: "Egress denied" }),
        transportCallCount: () => transportCalls,
      })),
    ).resolves.toMatchObject({ suite: "EgressBroker" });

    const attempted: string[] = [];
    await expect(
      runEnforcedEgressContract(() => ({
        isolationBoundary: "test remote worker",
        attempt: async (probe) => {
          await Promise.resolve();
          attempted.push(probe);
          throw new Error("blocked before connection");
        },
        connectionCount: () => 0,
      })),
    ).resolves.toMatchObject({ suite: "EnforcedEgress" });
    expect(attempted).toEqual(ENFORCED_EGRESS_PROBES);
  });

  it("passes the memory command unit-of-work contract", async () => {
    const commandId = "kafcmd_1767225600000_00000000000000000000000000000001";
    const scope: CommandScope = {
      issuerId: "contract-issuer",
      tenant: { id: "contract-tenant" },
      principal: { type: "user", id: "contract-user" },
      operation: "contract.execute",
      normalizedResourceScope: [],
      commandId,
    };
    const context = createCommandContext({
      commandId,
      operation: scope.operation,
      payload: { request: 1 },
    });
    await expect(
      runRunCommandUnitOfWorkContract(() => ({
        unitOfWork: createMemoryStoreSuite().runCommandUnitOfWork,
        scope,
        context,
        expectedValue: { runId: "contract-run" },
        sensitiveErrorMarker: "command-contract-sensitive-value",
        errorSurface: (error) => ({
          code:
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : "KAF_TESTING_COMMAND_FAILED",
          message: "Command rejected",
        }),
        observeAtomicCommandAndWakeup: () => Promise.resolve(false),
      })),
    ).resolves.toMatchObject({ suite: "RunCommandUnitOfWork" });
  });

  it("passes the MCP-style untrusted tool adapter contract", async () => {
    const exposedToolDigest = digestCanonicalJson({ tool: "exposed" });
    const unexposedToolDigest = digestCanonicalJson({ tool: "unexposed" });
    const sensitiveErrorMarker = "mcp-contract-sensitive-value";
    let protocolDispatches = 0;
    const callAuthorized = async (input: unknown, signal: AbortSignal): Promise<unknown> => {
      await Promise.resolve();
      if (signal.aborted) throw new Error("aborted");
      const parsed = JsonValueSchema.parse(input);
      protocolDispatches += 1;
      if (isJsonRecord(parsed) && parsed["mode"] === "malformed") {
        return JsonValueSchema.parse(undefined);
      }
      if (isJsonRecord(parsed) && parsed["mode"] === "failure") {
        throw new Error(sensitiveErrorMarker);
      }
      return { ok: true };
    };
    await expect(
      runMCPUntrustedToolAdapterContract(() => ({
        exposedToolDigest,
        unexposedToolDigest,
        input: { value: 1 },
        expectedOutput: { ok: true },
        malformedResponseInput: { mode: "malformed" },
        failureInput: { mode: "failure" },
        sensitiveErrorMarker,
        declaredCancellation: true,
        errorSurface: () => ({ code: "KAF_MCP_CONNECTION_FAILED", message: "MCP call failed" }),
        callAuthorized,
        callUnexposed: () => Promise.reject(new Error("not exposed")),
        callCrossTenant: () => Promise.reject(new Error("cross tenant")),
        protocolDispatchCount: () => protocolDispatches,
      })),
    ).resolves.toMatchObject({ suite: "MCPUntrustedToolAdapter" });
  });
});

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
