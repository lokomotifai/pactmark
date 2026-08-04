import {
  createCommandContext,
  canonicalJsonStringify,
  digestBytes,
  digestCanonicalJson,
  KafError,
  protectedEffectResultAad,
  type AcceptedAgentWorkOrder,
  type AuthorizationReservation,
  type Artifact,
  type CapabilityGrant,
  type CommandRecord,
  type CommandScope,
  type ContextSnapshot,
  type DataProtector,
  type EffectRecord,
  type InputSubmissionRecord,
  type ProtectedValueRef,
  type ProtectedEffectResultAadRecord,
  type ProtectedEffectResultRecord,
  type RunEvent,
} from "@pactmark/core";
import { describe, expect, it } from "vitest";

import {
  computeAcceptedWorkOrderBindingDigest,
  createMemoryStoreSuite,
  MemoryAcceptedWorkOrderStore,
  MemoryActiveExecutionReservationStore,
  MemoryArtifactStore,
  MemoryCircuitBreakerStore,
  MemoryEventStore,
  MemoryModelCallReservationStore,
  MemoryRunCommandUnitOfWork,
  MemoryRunLeaseStore,
} from "../src/index.js";

const instant = "2026-08-03T10:00:00.000Z";
const digest = (value: string) => digestBytes(new TextEncoder().encode(value));
const executionDefinition = {
  kind: "agent" as const,
  id: "support-agent",
  version: "1.0.0",
  agentDefinitionDigest: digest("agent-definition"),
};
const executionDefinitionDigest = digestCanonicalJson(executionDefinition);
const commandId = "kafcmd_1760000000000_0123456789abcdef0123456789abcdef";

function commandScope(tenantId = "tenant-a"): CommandScope {
  return {
    issuerId: "issuer",
    tenant: { id: tenantId },
    principal: { type: "user", id: "user-1" },
    operation: "run.start",
    normalizedResourceScope: [],
    commandId,
  };
}

function commandRecord(scope: CommandScope, requestDigest: string): CommandRecord {
  return {
    schemaVersion: "1",
    scope,
    requestDigest,
    status: "committed",
    resultReference: { kind: "response", responseReference: digest("response") },
    safeResponseDigest: digest("response"),
    firstSeenAt: instant,
    committedAt: instant,
    detailRetentionExpiresAt: "2026-08-04T10:00:00.000Z",
    idempotencyExpiresAt: "2026-08-04T10:00:00.000Z",
  };
}

function authorizationReservation(
  overrides: Partial<AuthorizationReservation> = {},
): AuthorizationReservation {
  return {
    schemaVersion: "1",
    authorizationReservationId: "authorization-1",
    authorizationKey: "effect-key-1",
    tenantId: "tenant-a",
    runId: "run-1",
    stepId: "step-1",
    toolCallId: "tool-call-1",
    effectKey: "effect-key-1",
    workOrderBindingDigest: workOrder().workOrderBindingDigest,
    executionDefinition,
    executionDefinitionDigest,
    toolId: "demo.mutate@1",
    toolVersion: "1.0.0",
    toolRegistrationDigest: digest("tool-registration"),
    policyRegistrationDigest: digest("policy-registration"),
    argumentsDigest: digest("arguments"),
    normalizedTargetDigest: digest("target"),
    grantId: "grant-1",
    secretRefIds: [],
    purposeCode: "support",
    purposeRegistryVersion: "1",
    state: "reserved",
    createdAt: instant,
    expiresAt: "2026-08-03T11:00:00.000Z",
    ...overrides,
  };
}

function preparedEffect(overrides: Partial<EffectRecord> = {}): EffectRecord {
  const authorization = authorizationReservation();
  const identity = {
    schemaVersion: "1" as const,
    effectId: "effect-1",
    tenantId: authorization.tenantId,
    runId: authorization.runId,
    stepId: authorization.stepId,
    toolCallId: authorization.toolCallId,
    effectKey: authorization.effectKey!,
    operationKey: "operation-1",
    executionDefinition,
    executionDefinitionDigest,
    workOrderBindingDigest: authorization.workOrderBindingDigest,
    toolId: authorization.toolId,
    toolVersion: authorization.toolVersion,
    toolRegistrationDigest: authorization.toolRegistrationDigest,
    strategy: "native" as const,
    strategyRegistrationDigest: digest("effect-strategy"),
    authorizationReservationId: authorization.authorizationReservationId,
    argumentsDigest: authorization.argumentsDigest,
    normalizedTargetDigest: authorization.normalizedTargetDigest,
    createdAt: instant,
  };
  return {
    ...identity,
    effectDigest: digestCanonicalJson(identity),
    state: "prepared",
    updatedAt: instant,
    ...overrides,
  } as EffectRecord;
}

function acknowledgedEffect(): Extract<EffectRecord, { state: "acknowledged" }> {
  const prepared = preparedEffect();
  const resultDigest = digestCanonicalJson({ receipt: "memory-effect-result" });
  return {
    ...prepared,
    state: "acknowledged",
    resultDigest,
    acknowledgement: {
      schemaVersion: "1",
      acknowledgementId: "acknowledgement-1",
      proofKind: "receiver_receipt",
      effectKey: prepared.effectKey,
      ...(prepared.operationKey === undefined ? {} : { operationKey: prepared.operationKey }),
      toolRegistrationDigest: prepared.toolRegistrationDigest,
      strategyRegistrationDigest: prepared.strategyRegistrationDigest,
      normalizedTargetDigest: prepared.normalizedTargetDigest,
      resultSchemaDigest: digest("result-schema"),
      resultDigest,
      proofDigest: digest("proof"),
      acknowledgedAt: instant,
    },
    updatedAt: instant,
  };
}

async function protectedEffectResult(
  protector: DataProtector,
  effect: Extract<EffectRecord, { state: "acknowledged" }>,
): Promise<ProtectedEffectResultRecord> {
  const result = { receipt: "memory-effect-result" };
  const plaintext = new TextEncoder().encode(canonicalJsonStringify(result));
  const material: ProtectedEffectResultAadRecord = {
    schemaVersion: "1",
    tenantId: effect.tenantId,
    runId: effect.runId,
    effectId: effect.effectId,
    effectDigest: effect.effectDigest,
    resultDigest: effect.resultDigest,
    byteSize: plaintext.byteLength,
    workOrderId: workOrder().id,
    workOrderBindingDigest: effect.workOrderBindingDigest,
    executionDefinition: effect.executionDefinition,
    executionDefinitionDigest: effect.executionDefinitionDigest,
    toolId: effect.toolId,
    toolVersion: effect.toolVersion,
    toolRegistrationDigest: effect.toolRegistrationDigest,
    strategy: effect.strategy,
    strategyRegistrationDigest: effect.strategyRegistrationDigest,
    resultSchemaDigest: effect.acknowledgement.resultSchemaDigest,
    purposeCode: workOrder().purpose.code,
    purposeRegistryVersion: workOrder().purpose.registryVersion,
    dataClass: workOrder().dataClass,
    createdAt: effect.updatedAt,
  };
  return {
    ...material,
    protectedValue: await protector.protect(protectedEffectResultAad(material), plaintext),
  };
}

function workOrder(overrides: Partial<AcceptedAgentWorkOrder> = {}): AcceptedAgentWorkOrder {
  const provisional: AcceptedAgentWorkOrder = {
    schemaVersion: "1",
    kind: "agent",
    id: "work-order-1",
    createdAt: instant,
    goal: "Produce a deterministic answer",
    input: { caseId: "case-1" },
    context: { roleFamily: "support", workflowId: "triage", riskClass: "low" },
    workMode: "assist",
    autonomyMode: "co_produce",
    decisionOwner: { mode: "principal", principal: { type: "user", id: "user-1" } },
    purpose: { code: "support", registryVersion: "1" },
    dataClass: "internal",
    retention: { mode: "session" },
    principal: { type: "user", id: "user-1" },
    tenant: { id: "tenant-a" },
    requestedCapabilities: ["artifact:write"],
    resourceScopeCeiling: [],
    budget: {
      maxTurns: 3,
      maxModelCalls: 2,
      maxToolCalls: 2,
      maxActiveExecutionMs: 5_000,
    },
    executionDefinition,
    executionDefinitionDigest,
    modelSecurityProfileDigest: digest("model-security"),
    modelResourceProfileDigest: digest("model-resource"),
    modelAdapterRegistrationDigest: digest("model-adapter"),
    workOrderBindingDigest: digest("provisional"),
    ...overrides,
  };
  return {
    ...provisional,
    workOrderBindingDigest: computeAcceptedWorkOrderBindingDigest(provisional),
  };
}

function capabilityGrant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  const accepted = workOrder();
  return {
    schemaVersion: "1",
    id: "grant-1",
    issuerId: "issuer",
    principal: accepted.principal,
    tenant: accepted.tenant,
    workOrderId: accepted.id,
    workOrderBindingDigest: accepted.workOrderBindingDigest,
    executionDefinition,
    executionDefinitionDigest,
    capability: "artifact:write",
    action: "write",
    toolId: "artifact.write",
    toolVersion: "1.0.0",
    toolRegistrationDigest: digest("tool-registration"),
    normalizedResources: [{ kind: "artifact", value: "run-1/output", normalizationVersion: "1" }],
    purpose: accepted.purpose,
    policyRegistrationDigest: digest("policy-registration"),
    maximumUses: 1,
    issuedAt: instant,
    expiresAt: "2026-08-03T11:00:00.000Z",
    ...overrides,
  };
}

function acceptedEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    schemaVersion: "1",
    eventId: "event-1",
    eventType: "RunAccepted",
    runId: "run-1",
    sequence: 1,
    occurredAt: instant,
    correlationId: "correlation-1",
    tenantId: "tenant-a",
    dataClass: "internal",
    executionDefinition,
    executionDefinitionDigest,
    payload: {
      workOrderId: "work-order-1",
      workOrderBindingDigest: workOrder().workOrderBindingDigest,
      requiredVerifierIds: [],
    },
    ...overrides,
  } as RunEvent;
}

function planningEvent(): RunEvent {
  return {
    schemaVersion: "1",
    eventId: "event-2",
    eventType: "PlanningStarted",
    runId: "run-1",
    sequence: 2,
    occurredAt: "2026-08-03T10:00:01.000Z",
    correlationId: "correlation-1",
    causationId: "event-1",
    tenantId: "tenant-a",
    dataClass: "internal",
    executionDefinition,
    executionDefinitionDigest,
    payload: { stepId: "step-1" },
  };
}

describe("MemoryEventStore", () => {
  it("deduplicates identical event IDs and rejects conflicting reuse", async () => {
    const store = new MemoryEventStore();
    await expect(store.append(acceptedEvent(), 0)).resolves.toEqual({
      sequence: 1,
      replayed: false,
    });
    await expect(store.append(acceptedEvent(), 0)).resolves.toEqual({
      sequence: 1,
      replayed: true,
    });
    await expect(store.append(acceptedEvent({ tenantId: "tenant-b" }), 0)).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
  });

  it("allows exactly one optimistic writer and keeps streams tenant-scoped", async () => {
    const store = new MemoryEventStore();
    await store.append(acceptedEvent(), 0);
    const second = planningEvent();
    const competing = { ...second, eventId: "event-competing", payload: { stepId: "other" } };
    const results = await Promise.allSettled([store.append(second, 1), store.append(competing, 1)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await collect(store.read("tenant-b", "run-1"))).toEqual([]);
    expect(await collect(store.read("tenant-a", "run-1"))).toHaveLength(2);
  });

  it("rebuilds a byte-equivalent projection from append-only events", async () => {
    const store = new MemoryEventStore();
    await store.append(acceptedEvent(), 0);
    await store.append(planningEvent(), 1);
    const before = await store.getProjection("tenant-a", "run-1");
    store.dropProjection("tenant-a", "run-1");
    expect(await store.getProjection("tenant-a", "run-1")).toBeUndefined();
    const rebuilt = store.rebuildProjection("tenant-a", "run-1");
    expect(digestCanonicalJson(rebuilt)).toBe(digestCanonicalJson(before));
  });
});

describe("immutable and protected records", () => {
  it("round-trips an immutable WorkOrder, isolates tenants, and rejects mutation", async () => {
    const store = new MemoryAcceptedWorkOrderStore();
    const accepted = workOrder();
    await store.putImmutable(accepted);
    await store.putImmutable(structuredClone(accepted));
    expect(await store.get("tenant-a", accepted.id)).toEqual(accepted);
    expect(await store.get("tenant-b", accepted.id)).toBeUndefined();
    await expect(store.putImmutable(workOrder({ goal: "Changed" }))).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
  });

  it("requires a protector for confidential WorkOrders", async () => {
    const noProtector = new MemoryAcceptedWorkOrderStore({
      allowedDataClasses: ["internal", "confidential"],
    });
    await expect(
      noProtector.putImmutable(workOrder({ dataClass: "confidential" })),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_SECURITY_PROFILE" });

    const protector = new TestProtector();
    const protectedStore = new MemoryAcceptedWorkOrderStore({
      allowedDataClasses: ["internal", "confidential"],
      dataProtector: protector,
    });
    const confidential = workOrder({ dataClass: "confidential" });
    await protectedStore.putImmutable(confidential);
    expect(await protectedStore.get("tenant-a", confidential.id)).toEqual(confidential);
    expect(protector.protectCalls).toBe(1);
  });
});

describe("context, input, and artifact stores", () => {
  it("stores immutable typed input and latest context only in the tenant namespace", async () => {
    let now = instant;
    const stores = createMemoryStoreSuite({ now: () => now });
    const submission = inputSubmission();
    await expect(stores.inputSubmissionStore.putOnce(submission)).resolves.toEqual(submission);
    await expect(stores.inputSubmissionStore.putOnce(submission)).resolves.toEqual(submission);
    await expect(
      stores.inputSubmissionStore.putOnce({ ...submission, valueDigest: digest("changed") }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    expect(await stores.inputSubmissionStore.get("tenant-b", "run-1", "request-1")).toBeUndefined();

    await stores.contextStore.put(contextSnapshot("snapshot-1", 1));
    await stores.contextStore.put(contextSnapshot("snapshot-2", 2));
    expect((await stores.contextStore.getLatest("tenant-a", "run-1"))?.snapshotId).toBe(
      "snapshot-2",
    );
    now = "2026-08-04T00:00:00.000Z";
    expect(await stores.contextStore.getLatest("tenant-a", "run-1")).toBeUndefined();
  });

  it("checks artifact size and content digest and returns defensive byte copies", async () => {
    const store = new MemoryArtifactStore({ maxInlineBytes: 4 });
    const content = new TextEncoder().encode("data");
    const metadata = artifact(content);
    await store.put(metadata, content);
    content[0] = 0;
    const stored = await store.get("tenant-a", metadata.artifactId);
    expect(new TextDecoder().decode(stored?.content)).toBe("data");
    if (stored !== undefined) stored.content[0] = 0;
    expect(
      new TextDecoder().decode((await store.get("tenant-a", metadata.artifactId))?.content),
    ).toBe("data");
    expect(await store.get("tenant-b", metadata.artifactId)).toBeUndefined();
    await expect(
      store.put(artifact(new TextEncoder().encode("large")), new TextEncoder().encode("large")),
    ).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
    });
  });
});

describe("MemoryRunLeaseStore fencing", () => {
  it("prevents stale holders from renewing or committing after fencing advances", async () => {
    let now = instant;
    const leaseStore = new MemoryRunLeaseStore({ now: () => now });
    const eventStore = new MemoryEventStore({ leaseStore });
    const first = await leaseStore.acquire("tenant-a", "run-1", "worker-1", 1_000);
    expect(first?.fencingToken).toBe(1);
    expect(await leaseStore.acquire("tenant-a", "run-1", "worker-2", 1_000)).toBeUndefined();
    await eventStore.appendFenced(acceptedEvent(), 0, first!);
    now = "2026-08-03T10:00:02.000Z";
    const second = await leaseStore.acquire("tenant-a", "run-1", "worker-2", 1_000);
    expect(second?.fencingToken).toBe(2);
    await expect(leaseStore.renew(first!, 1_000)).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    await expect(eventStore.appendFenced(planningEvent(), 1, first!)).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    await expect(eventStore.appendFenced(planningEvent(), 1, second!)).resolves.toEqual({
      sequence: 2,
      replayed: false,
    });
  });
});

function protectedValue(id: string): ProtectedValueRef {
  return {
    schemaVersion: "1",
    protectorId: "test-protector",
    keyId: "key-1",
    ciphertextRef: id,
    ciphertextDigest: digest(`ciphertext:${id}`),
    aadDigest: digest(`aad:${id}`),
    algorithm: "test-only",
  };
}

function inputSubmission(): InputSubmissionRecord {
  return {
    schemaVersion: "1",
    inputSubmissionRecordId: "submission-1",
    tenantId: "tenant-a",
    runId: "run-1",
    requestId: "request-1",
    requestingStepId: "step-1",
    requestingEventId: "event-input-requested",
    executionDefinition,
    executionDefinitionDigest,
    workOrderBindingDigest: workOrder().workOrderBindingDigest,
    inputSchemaDigest: digest("input-schema"),
    valueDigest: digest("input-value"),
    protectedValue: protectedValue("input-1"),
    submittingPrincipalId: "user-1",
    purposeCode: "support",
    purposeRegistryVersion: "1",
    dataClass: "internal",
    retention: { mode: "session" },
    consumingCommandId: "command-1",
    createdAt: instant,
  };
}

function contextSnapshot(snapshotId: string, sequence: number): ContextSnapshot {
  return {
    schemaVersion: "1",
    snapshotId,
    tenantId: "tenant-a",
    runId: "run-1",
    sequence,
    stepId: `step-${String(sequence)}`,
    executionDefinition,
    executionDefinitionDigest,
    workOrderBindingDigest: workOrder().workOrderBindingDigest,
    contextSchemaDigest: digest("context-schema"),
    contextDigest: digest(`context-${String(sequence)}`),
    protectedValue: protectedValue(snapshotId),
    byteSize: 42,
    purposeCode: "support",
    purposeRegistryVersion: "1",
    dataClass: "internal",
    retention: { mode: "session" },
    createdAt: instant,
    expiresAt: "2026-08-03T23:59:59.000Z",
  };
}

function artifact(content: Uint8Array): Artifact {
  const contentDigest = digestBytes(content);
  return {
    schemaVersion: "1",
    artifactId: `artifact-${String(content.byteLength)}`,
    artifactDigest: digest(`artifact-${String(content.byteLength)}`),
    contentDigest,
    mediaType: "text/plain",
    byteSize: content.byteLength,
    location: { kind: "inline", encoding: "utf8", content: new TextDecoder().decode(content) },
    tenantId: "tenant-a",
    producingRunId: "run-1",
    producingStepId: "step-1",
    owner: { type: "principal", id: "user-1" },
    visibility: "private",
    dataClass: "internal",
    purposeCode: "support",
    retention: { mode: "session" },
    provenance: {
      schemaVersion: "1",
      executionDefinition,
      executionDefinitionDigest,
      workOrderBindingDigest: workOrder().workOrderBindingDigest,
      producingEventId: "event-artifact",
      sourceArtifactDigests: [],
      toolRegistrationDigests: [],
      metadata: {},
    },
    createdAt: instant,
  };
}

class TestProtector implements DataProtector {
  readonly #values = new Map<string, Uint8Array>();
  protectCalls = 0;

  async protect(
    binding: Readonly<Record<string, string>>,
    plaintext: Uint8Array,
  ): Promise<ProtectedValueRef> {
    await Promise.resolve();
    this.protectCalls += 1;
    const ciphertextRef = `protected-${String(this.protectCalls)}`;
    this.#values.set(ciphertextRef, new Uint8Array(plaintext));
    return {
      schemaVersion: "1",
      protectorId: "test-protector",
      keyId: "key-1",
      ciphertextRef,
      ciphertextDigest: digestBytes(plaintext),
      aadDigest: digestCanonicalJson(binding),
      algorithm: "test-only",
    };
  }

  async unprotect(
    binding: Readonly<Record<string, string>>,
    reference: ProtectedValueRef,
  ): Promise<Uint8Array> {
    await Promise.resolve();
    if (reference.aadDigest !== digestCanonicalJson(binding))
      throw new KafError("KAF_STORAGE_SECURITY_PROFILE");
    const value = this.#values.get(reference.ciphertextRef);
    if (value === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    return new Uint8Array(value);
  }
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of input) values.push(value);
  return values;
}

describe("MemoryRunCommandUnitOfWork", () => {
  it("rolls back accepted work, grants, events, and wakeups as one process-local unit", async () => {
    const stores = createMemoryStoreSuite({ now: () => instant });
    const scope = commandScope();
    const command = createCommandContext({
      commandId,
      operation: scope.operation,
      payload: { atomicAggregate: true },
    });
    await expect(
      stores.runCommandUnitOfWork.transactCommand(scope, command, async (transaction) => {
        await transaction.putAcceptedWorkOrder(workOrder());
        await transaction.issueCapabilityGrant(capabilityGrant());
        await transaction.appendRunEvent(acceptedEvent());
        const projection = await stores.eventStore.getProjection("tenant-a", "run-1");
        if (projection === undefined) throw new Error("projection missing");
        await transaction.putRunProjection(projection);
        await transaction.enqueueWakeup({
          schemaVersion: "1",
          tenantId: "tenant-a",
          runId: "run-1",
          reason: "run_accepted",
          notBefore: instant,
          deduplicationKey: "run-1:accepted",
          payload: {},
        });
        await transaction.putCommandRecord(commandRecord(scope, command.requestDigest));
        throw new Error("crash-after-aggregate-writes");
      }),
    ).rejects.toThrow("crash-after-aggregate-writes");
    expect(await stores.acceptedWorkOrderStore.get("tenant-a", "work-order-1")).toBeUndefined();
    expect(await collect(stores.eventStore.read("tenant-a", "run-1"))).toEqual([]);
    expect(stores.capabilityGrantStore.snapshot().grants.size).toBe(0);
    expect(stores.wakeupQueue.size).toBe(0);
  });

  it("serializes concurrent commands and replays only the exact authority scope/body", async () => {
    const stores = createMemoryStoreSuite();
    const unit = stores.runCommandUnitOfWork;
    const command = createCommandContext({ commandId, operation: "run.start", payload: { x: 1 } });
    const scope = commandScope();
    let calls = 0;
    const execute = () =>
      unit.transactCommand(scope, command, async (transaction) => {
        calls += 1;
        await transaction.putCommandRecord(commandRecord(scope, command.requestDigest));
        return { runId: "run-1" };
      });
    const [first, replay] = await Promise.all([execute(), execute()]);
    expect(calls).toBe(1);
    expect(first.value).toEqual({ runId: "run-1" });
    expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);

    const otherScope = commandScope("tenant-b");
    const other = await unit.transactCommand(otherScope, command, async (transaction) => {
      calls += 1;
      await transaction.putCommandRecord(commandRecord(otherScope, command.requestDigest));
      return { runId: "run-2" };
    });
    expect(other.replayed).toBe(false);
    expect(other.value).toEqual({ runId: "run-2" });

    const changed = createCommandContext({ commandId, operation: "run.start", payload: { x: 2 } });
    await expect(
      unit.transactCommand(scope, changed, () => Promise.resolve({ runId: "never" })),
    ).rejects.toMatchObject({ code: "KAF_HTTP_IDEMPOTENCY_CONFLICT" });
  });

  it("fails closed when the callback omits or drifts the command record", async () => {
    const stores = createMemoryStoreSuite();
    const unit = new MemoryRunCommandUnitOfWork(stores);
    const command = createCommandContext({ commandId, operation: "run.start", payload: {} });
    const scope = commandScope();
    await expect(
      unit.transactCommand(scope, command, () => Promise.resolve("missing")),
    ).rejects.toThrow();
    await expect(
      unit.transactCommand(scope, command, async (transaction) => {
        await transaction.putCommandRecord(
          commandRecord(commandScope("tenant-b"), command.requestDigest),
        );
        return "drift";
      }),
    ).rejects.toMatchObject({ code: "KAF_HTTP_IDEMPOTENCY_CONFLICT" });
  });

  it("deduplicates a runtime transition by its complete fenced binding", async () => {
    const unit = createMemoryStoreSuite().runCommandUnitOfWork;
    const key = {
      schemaVersion: "1" as const,
      tenantId: "tenant-a",
      runId: "run-1",
      transitionKind: "model_turn",
      transitionKey: "step-1:attempt-1",
      workOrderBindingDigest: digestCanonicalJson({ workOrderId: "work-1" }),
      executionDefinitionDigest: digestCanonicalJson({ agent: "agent-1" }),
      leaseId: "lease-1",
      fencingToken: 7,
    };
    let calls = 0;
    const execute = () =>
      unit.transactTransition(key, async () => {
        await Promise.resolve();
        calls += 1;
        return { reservationId: "reservation-1" };
      });
    await expect(Promise.all([execute(), execute()])).resolves.toEqual([
      { reservationId: "reservation-1" },
      { reservationId: "reservation-1" },
    ]);
    expect(calls).toBe(1);
  });

  it("atomically commits and replays authorization plus prepared effect ledger writes", async () => {
    const stores = createMemoryStoreSuite();
    const key = {
      schemaVersion: "1" as const,
      tenantId: "tenant-a",
      runId: "run-1",
      transitionKind: "EffectPrepared",
      transitionKey: "effect-1:prepared",
      workOrderBindingDigest: workOrder().workOrderBindingDigest,
      executionDefinitionDigest,
      leaseId: "lease-1",
      fencingToken: 4,
    };
    let calls = 0;
    const execute = () =>
      stores.runCommandUnitOfWork.transactTransition(key, async (transaction) => {
        calls += 1;
        await transaction.putAuthorizationReservation(authorizationReservation());
        await transaction.putEffectRecord(preparedEffect());
        return { effectId: "effect-1" };
      });
    await expect(execute()).resolves.toEqual({ effectId: "effect-1" });
    await expect(execute()).resolves.toEqual({ effectId: "effect-1" });
    expect(calls).toBe(1);
    expect(
      await stores.effectLedger.getByEffectKey("tenant-a", "run-1", "effect-key-1"),
    ).toMatchObject({ effectId: "effect-1", state: "prepared" });
    expect(
      await stores.effectLedger.getAuthorizationReservation("tenant-a", "authorization-1"),
    ).toMatchObject({ authorizationKey: "effect-key-1", state: "reserved" });
  });

  it("rolls back authorization and effect writes on crash and rejects binding drift", async () => {
    const stores = createMemoryStoreSuite();
    const transition = (transitionKey: string) => ({
      schemaVersion: "1" as const,
      tenantId: "tenant-a",
      runId: "run-1",
      transitionKind: "EffectPrepared",
      transitionKey,
      workOrderBindingDigest: workOrder().workOrderBindingDigest,
      executionDefinitionDigest,
      leaseId: "lease-1",
      fencingToken: 5,
    });
    await expect(
      stores.runCommandUnitOfWork.transactTransition(transition("crash"), async (transaction) => {
        await transaction.putAuthorizationReservation(authorizationReservation());
        await transaction.putEffectRecord(preparedEffect());
        throw new Error("crash-after-effect-write");
      }),
    ).rejects.toThrow("crash-after-effect-write");
    expect(
      await stores.effectLedger.getByEffectId("tenant-a", "run-1", "effect-1"),
    ).toBeUndefined();
    expect(
      await stores.effectLedger.getAuthorizationReservation("tenant-a", "authorization-1"),
    ).toBeUndefined();

    await stores.runCommandUnitOfWork.transactTransition(
      transition("commit"),
      async (transaction) => {
        await transaction.putAuthorizationReservation(authorizationReservation());
        await transaction.putEffectRecord(preparedEffect());
        return null;
      },
    );
    await expect(
      stores.runCommandUnitOfWork.transactTransition(transition("changed-digest"), (transaction) =>
        transaction.putAuthorizationReservation(
          authorizationReservation({ argumentsDigest: digest("changed") }),
        ),
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      stores.runCommandUnitOfWork.transactTransition(transition("cross-tenant"), (transaction) =>
        transaction.putEffectRecord(preparedEffect({ tenantId: "tenant-b" })),
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
  });

  it("atomically rolls back and commits an acknowledged effect with its protected result", async () => {
    const protector = new TestProtector();
    const stores = createMemoryStoreSuite({ dataProtector: protector });
    const effect = acknowledgedEffect();
    const resultRecord = await protectedEffectResult(protector, effect);
    await stores.eventStore.append(acceptedEvent(), 0);
    const transition = (transitionKey: string) => ({
      schemaVersion: "1" as const,
      tenantId: "tenant-a",
      runId: "run-1",
      transitionKind: "EffectAcknowledged",
      transitionKey,
      workOrderBindingDigest: workOrder().workOrderBindingDigest,
      executionDefinitionDigest,
    });
    await expect(
      stores.runCommandUnitOfWork.transactTransition(
        transition("rollback"),
        async (transaction) => {
          await transaction.putAcceptedWorkOrder(workOrder());
          await transaction.putAuthorizationReservation(authorizationReservation());
          await transaction.putEffectRecord(effect);
          await transaction.putProtectedEffectResult(resultRecord);
          throw new Error("crash-after-protected-result");
        },
      ),
    ).rejects.toThrow("crash-after-protected-result");
    await expect(
      stores.effectLedger.getByEffectId("tenant-a", "run-1", "effect-1"),
    ).resolves.toBeUndefined();
    await expect(stores.effectLedger.getAcknowledgedResult(effect)).resolves.toBeUndefined();

    await expect(
      stores.runCommandUnitOfWork.transactTransition(
        transition("wrong-work-order"),
        async (transaction) => {
          await transaction.putAcceptedWorkOrder(workOrder());
          await transaction.putAuthorizationReservation(authorizationReservation());
          await transaction.putEffectRecord(effect);
          await transaction.putProtectedEffectResult({
            ...resultRecord,
            workOrderId: "wrong-work-order",
          });
          return null;
        },
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(stores.effectLedger.getAcknowledgedResult(effect)).resolves.toBeUndefined();

    await stores.runCommandUnitOfWork.transactTransition(
      transition("commit"),
      async (transaction) => {
        await transaction.putAcceptedWorkOrder(workOrder());
        await transaction.putAuthorizationReservation(authorizationReservation());
        await transaction.putEffectRecord(effect);
        await transaction.putProtectedEffectResult(resultRecord);
        return null;
      },
    );
    await expect(stores.effectLedger.getAcknowledgedResult(effect)).resolves.toEqual({
      receipt: "memory-effect-result",
    });
  });
});

describe("memory resource reservations", () => {
  it("enforces a tenant-wide limit across 100 distinct principals and replays exactly", async () => {
    const stores = createMemoryStoreSuite({
      now: () => instant,
      quotaLimits: [
        {
          schemaVersion: "1",
          scope: "tenant",
          metric: "request_start",
          resourceKey: "agent:help",
          maximum: 10,
          retryAfterSeconds: 5,
        },
      ],
    });
    const decisions = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        stores.quotaStore.reserve({
          schemaVersion: "1",
          tenant: { id: "tenant-a" },
          principal: { type: "user", id: `user-${String(index)}` },
          commandId: `kafcmd_1760000000000_${String(index).padStart(32, "0")}`,
          category: "request_start",
          resourceKey: "agent:help",
          amount: 1,
          leaseDurationMs: 60_000,
        }),
      ),
    );
    expect(decisions.filter((decision) => decision.admitted)).toHaveLength(10);
    expect(decisions.filter((decision) => !decision.admitted)).toHaveLength(90);

    const original = {
      schemaVersion: "1" as const,
      tenant: { id: "tenant-replay" },
      principal: { type: "user" as const, id: "user-1" },
      commandId,
      category: "request_start" as const,
      resourceKey: "agent:help",
      amount: 1,
      leaseDurationMs: 60_000,
    };
    await expect(stores.quotaStore.reserve(original)).resolves.toMatchObject({ admitted: true });
    await expect(stores.quotaStore.reserve(original)).resolves.toMatchObject({ admitted: true });
    await expect(stores.quotaStore.reserve({ ...original, amount: 2 })).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    const unkeyed = { ...original, tenant: { id: "tenant-unkeyed" } };
    Reflect.deleteProperty(unkeyed, "commandId");
    const firstUnkeyed = await stores.quotaStore.reserve(unkeyed);
    const secondUnkeyed = await stores.quotaStore.reserve(unkeyed);
    expect(firstUnkeyed.admitted && secondUnkeyed.admitted).toBe(true);
    if (firstUnkeyed.admitted && secondUnkeyed.admitted) {
      expect(firstUnkeyed.reservation.id).not.toBe(secondUnkeyed.reservation.id);
    }
  });

  it("settles active and model reservations once and rejects changed replay", () => {
    let activeNow = Date.parse(instant);
    const active = new MemoryActiveExecutionReservationStore(() =>
      new Date(activeNow).toISOString(),
    );
    const reserved = {
      schemaVersion: "1" as const,
      id: "active-1",
      tenant: { id: "tenant-a" },
      runId: "run-1",
      stepId: "step-1",
      boundary: "model" as const,
      boundaryKey: "model-1",
      leaseId: "lease-1",
      fencingToken: 2,
      startedAtServerTime: instant,
      maxChargeMs: 1000,
      state: "reserved" as const,
      expiresAt: "2026-08-03T10:01:00.000Z",
    };
    const normalizedReserved = active.putInTransaction(reserved, 2_000);
    expect(normalizedReserved).toMatchObject({
      startedAtServerTime: instant,
      expiresAt: "2026-08-03T10:00:01.000Z",
    });
    activeNow += 400;
    const settled = {
      ...normalizedReserved,
      state: "settled" as const,
      settledChargeMs: 400,
      refundedMs: 600,
      settledAtServerTime: "2026-08-03T10:00:01.000Z",
    };
    const normalizedSettled = active.putInTransaction(settled, 2_000);
    expect(normalizedSettled).toMatchObject({ settledChargeMs: 400, refundedMs: 600 });
    expect(active.putInTransaction(settled, 2_000)).toEqual(normalizedSettled);

    const models = new MemoryModelCallReservationStore();
    const model = {
      schemaVersion: "1" as const,
      reservationId: "model-reservation-1",
      tenantId: "tenant-a",
      runId: "run-1",
      stepId: "step-1",
      attempt: 1,
      workOrderBindingDigest: digest("work"),
      agentDefinitionDigest: digest("agent"),
      modelSecurityProfileDigest: digest("security"),
      modelResourceProfileDigest: digest("resource"),
      modelAdapterRegistrationDigest: digest("adapter"),
      inputBytes: 100,
      inputTokenUpperBound: 20,
      outputTokenMaximum: 30,
      outputBytesMaximum: 200,
      status: "accepted" as const,
      expiresAt: "2026-08-03T10:01:00.000Z",
      createdAt: instant,
    };
    expect(models.putInTransaction(model)).toEqual(model);
    expect(models.putInTransaction({ ...model, status: "dispatched" })).toMatchObject({
      status: "dispatched",
    });
    const modelSettled = {
      ...model,
      status: "settled" as const,
      settlement: {
        schemaVersion: "1" as const,
        inputBytes: 100,
        inputTokenLowerBound: 10,
        outputBytes: 50,
        outputTokenLowerBound: 5,
        chargedTokens: 15,
        chargedIoBytes: 150,
        settledAt: "2026-08-03T10:00:01.000Z",
      },
    };
    expect(models.putInTransaction(modelSettled)).toEqual(modelSettled);
    expect(() =>
      models.putInTransaction({
        ...modelSettled,
        settlement: { ...modelSettled.settlement, chargedTokens: 51 },
      }),
    ).toThrow(expect.objectContaining({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" }));
  });

  it("enforces aggregate tenant-run active time and refunds only DB-clock settlement remainder", () => {
    let wall = Date.parse(instant);
    const active = new MemoryActiveExecutionReservationStore(() => new Date(wall).toISOString());
    const reservation = (id: string, tenantId = "tenant-budget", runId = "run-budget") => ({
      schemaVersion: "1" as const,
      id,
      tenant: { id: tenantId },
      runId,
      stepId: id,
      boundary: "tool" as const,
      boundaryKey: id,
      leaseId: "lease-budget",
      fencingToken: 3,
      startedAtServerTime: "2000-01-01T00:00:00.000Z",
      maxChargeMs: 60,
      state: "reserved" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const first = active.putInTransaction(reservation("active-first"), 100);
    expect(first).toMatchObject({
      startedAtServerTime: instant,
      expiresAt: "2026-08-03T10:00:00.060Z",
    });
    expect(() => active.putInTransaction(reservation("active-over-budget"), 100)).toThrow(
      expect.objectContaining({
        code: "KAF_RUNTIME_CAPABILITY_MISSING",
        details: expect.objectContaining({
          reason: "active_execution_budget_exhausted",
        }) as unknown,
      }),
    );
    expect(() =>
      active.putInTransaction(reservation("active-other-tenant", "tenant-other"), 100),
    ).not.toThrow();
    expect(() =>
      active.putInTransaction(reservation("active-other-run", "tenant-budget", "run-other"), 100),
    ).not.toThrow();

    wall += 20;
    const settled = active.putInTransaction(
      {
        ...first,
        state: "settled",
        settledChargeMs: 59,
        refundedMs: 1,
        settledAtServerTime: "2099-01-01T00:00:00.000Z",
      },
      100,
    );
    expect(settled).toMatchObject({
      settledChargeMs: 20,
      refundedMs: 40,
      settledAtServerTime: "2026-08-03T10:00:00.020Z",
    });
    expect(active.consumedMilliseconds("tenant-budget", "run-budget")).toBe(20);
    expect(() => active.putInTransaction(reservation("active-after-refund"), 100)).not.toThrow();
  });

  it("uses compare-and-set and a fenced half-open probe", async () => {
    const store = new MemoryCircuitBreakerStore();
    const closed = {
      schemaVersion: "1" as const,
      tenantId: "tenant-a",
      providerKey: "provider-a",
      state: "closed" as const,
      failureCount: 0,
      updatedAt: instant,
    };
    await expect(store.compareAndSet(undefined, closed)).resolves.toBe(true);
    await expect(store.compareAndSet(undefined, closed)).resolves.toBe(false);
    await expect(
      store.compareAndSet(closed, {
        ...closed,
        state: "half_open",
        failureCount: 1,
        probeLeaseId: "probe-1",
        probeFencingToken: 1,
        updatedAt: "2026-08-03T10:00:01.000Z",
      }),
    ).resolves.toBe(true);
  });

  it("rolls admission, active execution, and model reservations back together on crash", async () => {
    const stores = createMemoryStoreSuite({
      now: () => instant,
      quotaLimits: [
        {
          schemaVersion: "1",
          scope: "tenant",
          metric: "request_start",
          resourceKey: "agent:atomic",
          maximum: 1,
          retryAfterSeconds: 1,
        },
      ],
    });
    const atomicWorkOrder = workOrder({
      id: "work-atomic",
      tenant: { id: "tenant-atomic" },
      budget: { ...workOrder().budget, maxActiveExecutionMs: 2_000 },
    });
    await stores.acceptedWorkOrderStore.putImmutable(atomicWorkOrder);
    await stores.eventStore.append(
      acceptedEvent({
        eventId: "event-atomic",
        tenantId: "tenant-atomic",
        runId: "run-atomic",
        dataClass: atomicWorkOrder.dataClass,
        payload: {
          workOrderId: atomicWorkOrder.id,
          workOrderBindingDigest: atomicWorkOrder.workOrderBindingDigest,
          requiredVerifierIds: [],
        },
      }),
      0,
    );
    const active = {
      schemaVersion: "1" as const,
      id: "active-atomic",
      tenant: { id: "tenant-atomic" },
      runId: "run-atomic",
      stepId: "step-1",
      boundary: "model" as const,
      boundaryKey: "model-1",
      leaseId: "lease-1",
      fencingToken: 1,
      startedAtServerTime: instant,
      maxChargeMs: 100,
      state: "reserved" as const,
      expiresAt: "2026-08-03T10:01:00.000Z",
    };
    const model = {
      schemaVersion: "1" as const,
      reservationId: "model-atomic",
      tenantId: "tenant-atomic",
      runId: "run-atomic",
      stepId: "step-1",
      attempt: 1,
      workOrderBindingDigest: digest("atomic-work"),
      agentDefinitionDigest: digest("atomic-agent"),
      modelSecurityProfileDigest: digest("atomic-security"),
      modelResourceProfileDigest: digest("atomic-resource"),
      modelAdapterRegistrationDigest: digest("atomic-adapter"),
      inputBytes: 10,
      inputTokenUpperBound: 2,
      outputTokenMaximum: 3,
      outputBytesMaximum: 20,
      status: "accepted" as const,
      expiresAt: "2026-08-03T10:01:00.000Z",
      createdAt: instant,
    };
    await expect(
      stores.runCommandUnitOfWork.transactTransition(
        {
          schemaVersion: "1",
          tenantId: "tenant-atomic",
          runId: "run-atomic",
          transitionKind: "reservation_bundle",
          transitionKey: "crash",
          workOrderBindingDigest: digest("atomic-work"),
          executionDefinitionDigest: digest("atomic-agent"),
        },
        async (transaction) => {
          await transaction.reserveAdmission({
            schemaVersion: "1",
            tenant: { id: "tenant-atomic" },
            principal: { type: "service", id: "worker" },
            category: "request_start",
            resourceKey: "agent:atomic",
            amount: 1,
            leaseDurationMs: 60_000,
          });
          await transaction.putActiveExecutionReservation(active, 2_000);
          await transaction.putModelCallReservation(model);
          throw new Error("reservation-crash");
        },
      ),
    ).rejects.toThrow("reservation-crash");
    expect(
      stores.activeExecutionReservationStore.get(
        "tenant-atomic",
        "run-atomic",
        "step-1",
        "model",
        "model-1",
      ),
    ).toBeUndefined();
    expect(
      stores.modelCallReservationStore.get("tenant-atomic", "run-atomic", "step-1", 1),
    ).toBeUndefined();
    await expect(
      stores.quotaStore.reserve({
        schemaVersion: "1",
        tenant: { id: "tenant-atomic" },
        principal: { type: "service", id: "other-worker" },
        category: "request_start",
        resourceKey: "agent:atomic",
        amount: 1,
        leaseDurationMs: 60_000,
      }),
    ).resolves.toMatchObject({ admitted: true });
  });
});
