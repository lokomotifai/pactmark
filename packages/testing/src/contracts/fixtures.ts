import {
  AcceptedAgentWorkOrderSchema,
  ArtifactSchema,
  CommandRecordSchema,
  ContextSnapshotSchema,
  InputSubmissionRecordSchema,
  digestBytes,
  digestCanonicalJson,
  type AcceptedAgentWorkOrder,
  type Artifact,
  type CommandRecord,
  type CommandScope,
  type ContextSnapshot,
  type Digest,
  type InputSubmissionRecord,
  type RunEvent,
} from "@pactmark/core";

export const CONTRACT_INSTANT = "2026-01-01T00:00:00.000Z";

export const CONTRACT_EXECUTION_DEFINITION = Object.freeze({
  kind: "agent" as const,
  id: "testing-agent",
  version: "1.0.0",
  agentDefinitionDigest: contractDigest("agent-definition"),
});

export const CONTRACT_EXECUTION_DEFINITION_DIGEST = digestCanonicalJson(
  CONTRACT_EXECUTION_DEFINITION,
);

export function contractDigest(seed: string): Digest {
  return digestCanonicalJson({ seed });
}

export function createContractCommandRecord(
  scope: CommandScope,
  requestDigest: Digest,
  overrides: Partial<CommandRecord> = {},
): CommandRecord {
  return CommandRecordSchema.parse({
    schemaVersion: "1",
    scope,
    requestDigest,
    status: "committed",
    resultReference: { kind: "response", responseReference: "contract:response" },
    safeResponseDigest: contractDigest("safe-command-response"),
    firstSeenAt: CONTRACT_INSTANT,
    committedAt: CONTRACT_INSTANT,
    detailRetentionExpiresAt: "2026-01-02T00:00:00.000Z",
    idempotencyExpiresAt: "2026-01-03T00:00:00.000Z",
    ...overrides,
  });
}

export function createContractWorkOrder(
  overrides: Partial<AcceptedAgentWorkOrder> = {},
): AcceptedAgentWorkOrder {
  const material = {
    schemaVersion: "1" as const,
    kind: "agent" as const,
    id: "contract-work-order",
    createdAt: CONTRACT_INSTANT,
    goal: "Exercise the store contract",
    input: { caseId: "contract-case" },
    context: { roleFamily: "testing", workflowId: "store-contract", riskClass: "low" as const },
    workMode: "assist" as const,
    autonomyMode: "co_produce" as const,
    decisionOwner: {
      mode: "principal" as const,
      principal: { type: "user" as const, id: "contract-user" },
    },
    purpose: { code: "testing", registryVersion: "1" },
    dataClass: "internal" as const,
    retention: { mode: "session" as const },
    principal: { type: "user" as const, id: "contract-user" },
    tenant: { id: "contract-tenant" },
    requestedCapabilities: [] as string[],
    resourceScopeCeiling: [] as never[],
    budget: {
      maxTurns: 2,
      maxModelCalls: 2,
      maxToolCalls: 2,
      maxActiveExecutionMs: 10_000,
    },
    executionDefinition: CONTRACT_EXECUTION_DEFINITION,
    executionDefinitionDigest: CONTRACT_EXECUTION_DEFINITION_DIGEST,
    modelSecurityProfileDigest: contractDigest("model-security"),
    modelResourceProfileDigest: contractDigest("model-resource"),
    modelAdapterRegistrationDigest: contractDigest("model-adapter"),
    ...overrides,
  };
  return AcceptedAgentWorkOrderSchema.parse({
    ...material,
    workOrderBindingDigest: digestCanonicalJson(material),
  });
}

export function createContractRunAcceptedEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  const workOrder = createContractWorkOrder();
  return {
    schemaVersion: "1",
    eventId: "contract-event-1",
    eventType: "RunAccepted",
    runId: "contract-run",
    sequence: 1,
    occurredAt: CONTRACT_INSTANT,
    correlationId: "contract-correlation",
    tenantId: "contract-tenant",
    dataClass: "internal",
    executionDefinition: CONTRACT_EXECUTION_DEFINITION,
    executionDefinitionDigest: CONTRACT_EXECUTION_DEFINITION_DIGEST,
    payload: {
      workOrderId: workOrder.id,
      workOrderBindingDigest: workOrder.workOrderBindingDigest,
      requiredVerifierIds: [],
    },
    ...overrides,
  } as RunEvent;
}

export function createContractPlanningEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    schemaVersion: "1",
    eventId: "contract-event-2",
    eventType: "PlanningStarted",
    runId: "contract-run",
    sequence: 2,
    occurredAt: "2026-01-01T00:00:01.000Z",
    correlationId: "contract-correlation",
    causationId: "contract-event-1",
    tenantId: "contract-tenant",
    dataClass: "internal",
    executionDefinition: CONTRACT_EXECUTION_DEFINITION,
    executionDefinitionDigest: CONTRACT_EXECUTION_DEFINITION_DIGEST,
    payload: { stepId: "contract-step" },
    ...overrides,
  } as RunEvent;
}

export function createContractProtectedValue(seed: string) {
  return {
    schemaVersion: "1" as const,
    protectorId: "contract-protector",
    keyId: "contract-key",
    ciphertextRef: `memory:${seed}`,
    ciphertextDigest: contractDigest(`${seed}:ciphertext`),
    aadDigest: contractDigest(`${seed}:aad`),
    algorithm: "contract-only",
  };
}

export function createContractInputSubmission(
  overrides: Partial<InputSubmissionRecord> = {},
): InputSubmissionRecord {
  return InputSubmissionRecordSchema.parse({
    schemaVersion: "1",
    inputSubmissionRecordId: "contract-input-record",
    tenantId: "contract-tenant",
    runId: "contract-run",
    requestId: "contract-request",
    requestingStepId: "contract-step",
    requestingEventId: "contract-input-requested-event",
    executionDefinition: CONTRACT_EXECUTION_DEFINITION,
    executionDefinitionDigest: CONTRACT_EXECUTION_DEFINITION_DIGEST,
    workOrderBindingDigest: createContractWorkOrder().workOrderBindingDigest,
    inputSchemaDigest: contractDigest("input-schema"),
    valueDigest: contractDigest("input-value"),
    protectedValue: createContractProtectedValue("input"),
    submittingPrincipalId: "contract-user",
    purposeCode: "testing",
    purposeRegistryVersion: "1",
    dataClass: "internal",
    retention: { mode: "session" },
    consumingCommandId: "contract-command",
    createdAt: CONTRACT_INSTANT,
    ...overrides,
  });
}

export function createContractContextSnapshot(
  sequence = 1,
  overrides: Partial<ContextSnapshot> = {},
): ContextSnapshot {
  return ContextSnapshotSchema.parse({
    schemaVersion: "1",
    snapshotId: `contract-snapshot-${String(sequence)}`,
    tenantId: "contract-tenant",
    runId: "contract-run",
    sequence,
    stepId: "contract-step",
    executionDefinition: CONTRACT_EXECUTION_DEFINITION,
    executionDefinitionDigest: CONTRACT_EXECUTION_DEFINITION_DIGEST,
    workOrderBindingDigest: createContractWorkOrder().workOrderBindingDigest,
    contextSchemaDigest: contractDigest("context-schema"),
    contextDigest: contractDigest(`context-${String(sequence)}`),
    protectedValue: createContractProtectedValue(`context-${String(sequence)}`),
    byteSize: 32,
    purposeCode: "testing",
    purposeRegistryVersion: "1",
    dataClass: "internal",
    retention: { mode: "session" },
    createdAt: new Date(Date.parse(CONTRACT_INSTANT) + sequence * 1_000).toISOString(),
    ...overrides,
  });
}

export function createContractArtifact(content = new TextEncoder().encode("contract artifact")): {
  readonly artifact: Artifact;
  readonly content: Uint8Array;
} {
  const contentDigest = digestBytes(content);
  const inlineContent = bytesToBase64(content);
  const material = {
    schemaVersion: "1" as const,
    artifactId: "contract-artifact",
    contentDigest,
    mediaType: "text/plain",
    byteSize: content.byteLength,
    location: { kind: "inline" as const, encoding: "base64" as const, content: inlineContent },
    tenantId: "contract-tenant",
    producingRunId: "contract-run",
    producingStepId: "contract-step",
    owner: { type: "tenant" as const, id: "contract-tenant" },
    visibility: "tenant" as const,
    dataClass: "internal" as const,
    purposeCode: "testing",
    retention: { mode: "session" as const },
    provenance: {
      schemaVersion: "1" as const,
      executionDefinition: CONTRACT_EXECUTION_DEFINITION,
      executionDefinitionDigest: CONTRACT_EXECUTION_DEFINITION_DIGEST,
      workOrderBindingDigest: createContractWorkOrder().workOrderBindingDigest,
      producingEventId: "contract-artifact-event",
      sourceArtifactDigests: [] as Digest[],
      toolRegistrationDigests: [] as Digest[],
      metadata: {},
    },
    createdAt: CONTRACT_INSTANT,
  };
  return {
    artifact: ArtifactSchema.parse({ ...material, artifactDigest: digestCanonicalJson(material) }),
    content: new Uint8Array(content),
  };
}

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
