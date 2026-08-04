import {
  digestBytes,
  digestCanonicalJson,
  canonicalJsonStringify,
  protectedEffectResultAad,
  type AcceptedAgentWorkOrder,
  type Artifact,
  type ContextSnapshot,
  type EvidenceRecord,
  type DataProtector,
  type EffectRecord,
  type ProtectedEffectResultAadRecord,
  type ProtectedEffectResultRecord,
  type InputSubmissionRecord,
  type PatternRecord,
  type ProtectedValueRef,
  type RunEvent,
  type VerificationRecord,
} from "@pactmark/core";

import { computeAcceptedWorkOrderBindingDigest } from "../src/record-stores.js";

export const instant = "2026-08-03T10:00:00.000Z";
export const digest = (value: string) => digestBytes(new TextEncoder().encode(value));
export const executionDefinition = {
  kind: "agent" as const,
  id: "support-agent",
  version: "1.0.0",
  agentDefinitionDigest: digest("agent-definition"),
};
export const executionDefinitionDigest = digestCanonicalJson(executionDefinition);

export function acceptedWorkOrder(
  overrides: Partial<AcceptedAgentWorkOrder> = {},
): AcceptedAgentWorkOrder {
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
    budget: { maxTurns: 3, maxModelCalls: 2, maxToolCalls: 2, maxActiveExecutionMs: 5_000 },
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

export function runAccepted(overrides: Partial<RunEvent> = {}): RunEvent {
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
      workOrderBindingDigest: acceptedWorkOrder().workOrderBindingDigest,
      requiredVerifierIds: [],
    },
    ...overrides,
  } as RunEvent;
}

export function planningStarted(): RunEvent {
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

export function protectedValue(id: string): ProtectedValueRef {
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

export function inputSubmission(): InputSubmissionRecord {
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
    workOrderBindingDigest: acceptedWorkOrder().workOrderBindingDigest,
    inputSchemaDigest: digest("input-schema"),
    valueDigest: digest("input-value"),
    protectedValue: protectedValue("input-1"),
    submittingPrincipalId: "user-1",
    purposeCode: "support",
    purposeRegistryVersion: "1",
    dataClass: "internal",
    retention: { mode: "until", expiresAt: "2026-08-04T00:00:00.000Z" },
    consumingCommandId: "command-1",
    createdAt: instant,
  };
}

export const acknowledgedEffectResult = {
  receipt: "PLAINTEXT-EFFECT-RESULT-CANARY",
} as const;

export function acknowledgedEffect(
  overrides: Partial<EffectRecord> = {},
): Extract<EffectRecord, { state: "acknowledged" }> {
  const authorization = {
    tenantId: overrides.tenantId ?? "tenant-a",
    runId: overrides.runId ?? "run-1",
    effectId: overrides.effectId ?? "effect-1",
  };
  const identity = {
    schemaVersion: "1" as const,
    effectId: authorization.effectId,
    tenantId: authorization.tenantId,
    runId: authorization.runId,
    stepId: "step-1",
    toolCallId: "tool-call-1",
    effectKey: `${authorization.tenantId}:${authorization.effectId}:effect-key`,
    operationKey: `${authorization.tenantId}:${authorization.effectId}:operation-key`,
    executionDefinition,
    executionDefinitionDigest,
    workOrderBindingDigest: acceptedWorkOrder({ tenant: { id: authorization.tenantId } })
      .workOrderBindingDigest,
    toolId: "demo.mutate@1",
    toolVersion: "1.0.0",
    toolRegistrationDigest: digest("tool-registration"),
    strategy: "native" as const,
    strategyRegistrationDigest: digest("effect-strategy"),
    authorizationReservationId: `${authorization.tenantId}:${authorization.effectId}:authorization`,
    argumentsDigest: digest("arguments"),
    normalizedTargetDigest: digest("target"),
    createdAt: instant,
  };
  const resultDigest = digestCanonicalJson(acknowledgedEffectResult);
  return {
    ...identity,
    effectDigest: digestCanonicalJson(identity),
    state: "acknowledged",
    resultDigest,
    acknowledgement: {
      schemaVersion: "1",
      acknowledgementId: `${authorization.tenantId}:${authorization.effectId}:acknowledgement`,
      proofKind: "receiver_receipt",
      effectKey: identity.effectKey,
      operationKey: identity.operationKey,
      toolRegistrationDigest: identity.toolRegistrationDigest,
      strategyRegistrationDigest: identity.strategyRegistrationDigest,
      normalizedTargetDigest: identity.normalizedTargetDigest,
      resultSchemaDigest: digest("result-schema"),
      resultDigest,
      proofDigest: digest("proof"),
      acknowledgedAt: instant,
    },
    updatedAt: instant,
    ...overrides,
  } as Extract<EffectRecord, { state: "acknowledged" }>;
}

export async function protectedEffectResult(
  protector: DataProtector,
  effect = acknowledgedEffect(),
  overrides: Partial<ProtectedEffectResultAadRecord> = {},
): Promise<ProtectedEffectResultRecord> {
  const plaintext = new TextEncoder().encode(canonicalJsonStringify(acknowledgedEffectResult));
  const workOrder = acceptedWorkOrder({ tenant: { id: effect.tenantId } });
  if (workOrder.dataClass === "highly_restricted") {
    throw new Error("protected effect result fixture forbids highly_restricted data");
  }
  const material: ProtectedEffectResultAadRecord = {
    schemaVersion: "1",
    tenantId: effect.tenantId,
    runId: effect.runId,
    effectId: effect.effectId,
    effectDigest: effect.effectDigest,
    resultDigest: effect.resultDigest,
    byteSize: plaintext.byteLength,
    workOrderId: workOrder.id,
    workOrderBindingDigest: effect.workOrderBindingDigest,
    executionDefinition: effect.executionDefinition,
    executionDefinitionDigest: effect.executionDefinitionDigest,
    toolId: effect.toolId,
    toolVersion: effect.toolVersion,
    toolRegistrationDigest: effect.toolRegistrationDigest,
    strategy: effect.strategy,
    strategyRegistrationDigest: effect.strategyRegistrationDigest,
    resultSchemaDigest: effect.acknowledgement.resultSchemaDigest,
    purposeCode: workOrder.purpose.code,
    purposeRegistryVersion: workOrder.purpose.registryVersion,
    dataClass: workOrder.dataClass,
    createdAt: effect.updatedAt,
    ...overrides,
  };
  return {
    ...material,
    protectedValue: await protector.protect(protectedEffectResultAad(material), plaintext),
  };
}

export function contextSnapshot(id = "snapshot-1", sequence = 1): ContextSnapshot {
  return {
    schemaVersion: "1",
    snapshotId: id,
    tenantId: "tenant-a",
    runId: "run-1",
    sequence,
    stepId: "step-1",
    executionDefinition,
    executionDefinitionDigest,
    workOrderBindingDigest: acceptedWorkOrder().workOrderBindingDigest,
    contextSchemaDigest: digest("context-schema"),
    contextDigest: digest(`context:${id}`),
    protectedValue: protectedValue(`context:${id}`),
    byteSize: 10,
    purposeCode: "support",
    purposeRegistryVersion: "1",
    dataClass: "internal",
    retention: { mode: "until", expiresAt: "2026-08-04T00:00:00.000Z" },
    createdAt: instant,
    expiresAt: "2026-08-04T00:00:00.000Z",
  };
}

export function artifact(content: Uint8Array): Artifact {
  const contentDigest = digestBytes(content);
  return {
    schemaVersion: "1",
    artifactId: "artifact-1",
    artifactDigest: digest("artifact-metadata"),
    contentDigest,
    mediaType: "text/plain",
    byteSize: content.byteLength,
    location: { kind: "inline", encoding: "utf8", content: new TextDecoder().decode(content) },
    tenantId: "tenant-a",
    producingRunId: "run-1",
    producingStepId: "step-1",
    owner: { type: "tenant", id: "tenant-a" },
    visibility: "tenant",
    dataClass: "internal",
    purposeCode: "support",
    retention: { mode: "session" },
    provenance: {
      schemaVersion: "1",
      executionDefinition,
      executionDefinitionDigest,
      workOrderBindingDigest: acceptedWorkOrder().workOrderBindingDigest,
      producingEventId: "event-artifact",
      sourceArtifactDigests: [],
      toolRegistrationDigests: [],
      metadata: {},
    },
    createdAt: instant,
  };
}

export function verificationRecord(tenantId = "tenant-a", runId = "run-1"): VerificationRecord {
  const material = {
    schemaVersion: "1" as const,
    status: "pass" as const,
    verificationId: "verification-1",
    verifierId: "integrity",
    verifierVersion: "1",
    verifierRegistrationDigest: digest("verifier"),
    method: "deterministic" as const,
    artifactDigest: digest("artifact"),
    findings: [],
    rubricVersion: "1",
    rubricDigest: digest("rubric"),
    verifiedAt: instant,
  };
  return {
    schemaVersion: "1",
    tenantId,
    runId,
    purposeCode: "support",
    dataClass: "internal",
    verification: { ...material, verificationDigest: digestCanonicalJson(material) },
  };
}

export function patternRecord(tenantId = "tenant-a"): PatternRecord {
  const material = {
    schemaVersion: "1" as const,
    patternId: "pattern-1",
    version: "1",
    title: "Support triage",
    description: "A bounded fixture pattern",
    maturity: "candidate" as const,
    scaleUnit: { roleFamily: "support", workflowId: "triage", riskClass: "low" as const },
    assetRefs: [{ kind: "agent" as const, id: "agent-1", version: "1", digest: digest("agent") }],
    evidenceRecordDigests: [],
    independentObservationCount: 0,
    supportedClaims: ["Supports fixture testing"],
    doesNotProve: ["Production effectiveness"],
    createdAt: instant,
    updatedAt: instant,
  };
  return {
    schemaVersion: "1",
    tenantId,
    purposeCode: "support",
    dataClass: "internal",
    pattern: { ...material, patternDigest: digestCanonicalJson(material) },
  };
}

export function evidenceRecord(tenantId = "tenant-a"): EvidenceRecord {
  const material = {
    schemaVersion: "1" as const,
    evidenceRecordId: "evidence-1",
    tenantId,
    runId: "run-1",
    executionDefinition,
    executionDefinitionDigest,
    workOrderBindingDigest: digest("work-order"),
    claim: { statement: "Fixture completed", claimType: "technical", scope: "one run" },
    supports: ["Artifact integrity"],
    doesNotProve: ["Business outcome"],
    context: {
      roleFamily: "support",
      workflowId: "triage",
      riskClass: "low" as const,
      purposeCode: "support",
    },
    workSplit: {
      ai: { kind: "numeric" as const, value: 1, unit: "step" },
      human: { kind: "numeric" as const, value: 0, unit: "step" },
      description: "Fixture split",
    },
    artifactRefs: [{ artifactId: "artifact-1", artifactDigest: digest("artifact") }],
    eventRefs: [{ eventId: "event-1", sequence: 1 }],
    approvalRefs: [],
    verificationRefs: [],
    verificationExceptionRefs: [],
    permission: {
      purposeCode: "support",
      purposeRegistryVersion: "1",
      visibility: "tenant" as const,
      dataClass: "internal" as const,
      retention: { mode: "session" as const },
    },
    freshness: { observedAt: instant, validAt: instant },
    observation: {
      firstObservedAt: instant,
      lastObservedAt: instant,
      count: 1,
      repetitionStatus: "single" as const,
      independentObservationIds: ["observation-1"],
    },
    createdAt: instant,
  };
  return { ...material, evidenceDigest: digestCanonicalJson(material) };
}
