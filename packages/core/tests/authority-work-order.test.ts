import { describe, expect, it } from "vitest";

import { ActiveExecutionReservationSchema, AdmissionReservationSchema } from "../src/admission.js";
import { ModelCallReservationSchema } from "../src/model.js";
import { createAuthorityIssuer } from "../src/authority.js";
import { CapabilityGrantSchema } from "../src/capability.js";
import {
  CommandRecordSchema,
  createCommandContext,
  createCommandId,
  validateCommandIdWindow,
} from "../src/commands.js";
import { ApprovalSchema, DecisionSubmissionChallengeSchema } from "../src/decision.js";
import { RunDelegationDescriptorSchema } from "../src/delegation.js";
import {
  AcceptedAgentWorkOrderSchema,
  AcceptedCompensationWorkOrderSchema,
  AcceptedWorkOrderSchema,
  WorkOrderRequestSchema,
  createWorkOrderRequest,
} from "../src/work-order.js";

const digest = `sha256:${"0".repeat(64)}`;
const laterDigest = `sha256:${"1".repeat(64)}`;
const now = "2026-08-03T12:00:00.000Z";
const later = "2026-08-03T13:00:00.000Z";
const principal = { type: "user" as const, id: "user-1" };
const tenant = { id: "tenant-1" };
const purpose = { code: "service_delivery", registryVersion: "general@1" };
const resource = { kind: "dataset", value: "public/market", normalizationVersion: "resource@1" };
const agentExecution = {
  kind: "agent" as const,
  id: "research-agent",
  version: "0.1.0",
  agentDefinitionDigest: digest,
};
const compensationExecution = {
  kind: "compensation" as const,
  id: "undo-publish",
  version: "0.1.0",
  compensationRunDefinitionDigest: digest,
  originalAgentDefinitionDigest: digest,
  originalEffectDigest: digest,
  compensationStrategyRegistrationDigest: digest,
  compensationToolRegistrationDigest: digest,
};

const requestInput = {
  agent: { id: "research-agent", version: "0.1.0" },
  goal: "Prepare a source-backed market brief.",
  input: { topic: "agent frameworks" },
  context: { roleFamily: "research", workflowId: "market-brief", riskClass: "low" as const },
  workMode: "augment" as const,
  autonomyMode: "delegate_review" as const,
  decisionOwner: { mode: "requesting_principal" as const },
  purpose,
  dataClass: "public" as const,
  retention: { mode: "session" as const },
  requestedCapabilities: ["knowledge:read"],
  budget: { maxTurns: 12, maxModelCalls: 12, maxToolCalls: 30, maxActiveExecutionMs: 180_000 },
};

const acceptedCommon = {
  schemaVersion: "1" as const,
  id: "wo-1",
  createdAt: now,
  goal: requestInput.goal,
  input: requestInput.input,
  context: requestInput.context,
  workMode: requestInput.workMode,
  autonomyMode: requestInput.autonomyMode,
  decisionOwner: { mode: "principal" as const, principal },
  purpose,
  dataClass: requestInput.dataClass,
  retention: requestInput.retention,
  principal,
  tenant,
  requestedCapabilities: requestInput.requestedCapabilities,
  resourceScopeCeiling: [resource],
  budget: requestInput.budget,
  workOrderBindingDigest: digest,
};

function roundTrip<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  const parsed = schema.parse(value);
  return schema.parse(JSON.parse(JSON.stringify(parsed)));
}

describe("authority and WorkOrder boundary", () => {
  it("issues process-local authority that JSON and another issuer cannot forge", () => {
    const issuer = createAuthorityIssuer("host-a");
    const authority = issuer.issue({
      actor: principal,
      tenant,
      authenticatedAt: now,
      authenticationStrength: "multi_factor",
      decisionRoles: ["owner"],
      requestCorrelationId: "request-1",
      issuedAt: now,
      expiresAt: later,
    });

    expect(issuer.verify(authority, new Date("2026-08-03T12:30:00.000Z"))).toMatchObject({
      valid: true,
    });
    expect(() => JSON.stringify(authority)).toThrow("not serializable");
    expect(issuer.verify({}, new Date(now))).toEqual({ valid: false, reason: "not_issued" });
    expect(createAuthorityIssuer("host-b").verify(authority, new Date(now))).toEqual({
      valid: false,
      reason: "other_issuer",
    });
    expect(issuer.verify(authority, new Date(later))).toEqual({ valid: false, reason: "expired" });
    expect(issuer.verify(authority, new Date("2026-08-03T11:59:59.000Z"))).toEqual({
      valid: false,
      reason: "not_yet_valid",
    });
  });

  it("accepts untrusted intent while rejecting every server-owned field and grants", () => {
    expect(createWorkOrderRequest(requestInput)).toMatchObject({
      schemaVersion: "1",
      resourceScopeCeiling: [],
    });
    for (const forbidden of [
      "id",
      "createdAt",
      "principal",
      "tenant",
      "grants",
      "capabilityGrant",
    ]) {
      expect(
        WorkOrderRequestSchema.safeParse({ ...requestInput, [forbidden]: "forged" }).success,
      ).toBe(false);
    }
    expect(
      WorkOrderRequestSchema.safeParse({
        ...requestInput,
        decisionOwner: { mode: "principal", principal },
      }).success,
    ).toBe(false);
    expect(
      WorkOrderRequestSchema.safeParse({
        ...requestInput,
        budget: { ...requestInput.budget, maxTurns: Infinity },
      }).success,
    ).toBe(false);
    expect(
      WorkOrderRequestSchema.safeParse({
        ...requestInput,
        resourceScopeCeiling: [
          { kind: "banana", value: "*", normalizationVersion: "unregistered" },
        ],
      }).success,
    ).toBe(false);
  });

  it("round-trips distinct accepted agent and compensation variants", () => {
    const acceptedAgent = roundTrip(AcceptedAgentWorkOrderSchema, {
      ...acceptedCommon,
      kind: "agent",
      executionDefinition: agentExecution,
      executionDefinitionDigest: digest,
      modelSecurityProfileDigest: digest,
      modelResourceProfileDigest: digest,
      modelAdapterRegistrationDigest: digest,
    });
    expect(AcceptedWorkOrderSchema.parse(acceptedAgent).kind).toBe("agent");

    const acceptedCompensation = roundTrip(AcceptedCompensationWorkOrderSchema, {
      ...acceptedCommon,
      kind: "compensation",
      executionDefinition: compensationExecution,
      executionDefinitionDigest: digest,
      originalRunId: "run-original",
      originalEffectId: "effect-original",
      originalEffectDigest: digest,
      originalEffectResultDigest: digest,
      originalEffectAcknowledgementDigest: digest,
      compensationStrategyRegistrationDigest: digest,
      compensationToolId: "publication.undo",
      compensationToolVersion: "1.0.0",
      compensationToolRegistrationDigest: digest,
    });
    expect(AcceptedWorkOrderSchema.parse(acceptedCompensation).kind).toBe("compensation");
    expect(
      AcceptedCompensationWorkOrderSchema.safeParse({
        ...acceptedCompensation,
        modelSecurityProfileDigest: digest,
      }).success,
    ).toBe(false);
    expect(
      AcceptedCompensationWorkOrderSchema.safeParse({
        ...acceptedCompensation,
        executionDefinition: agentExecution,
      }).success,
    ).toBe(false);
  });
});

describe("exact authority bindings", () => {
  const proposedEffect = {
    schemaVersion: "1" as const,
    tenant,
    principal,
    runId: "run-1",
    stepId: "step-1",
    decisionId: "decision-1",
    workOrderBindingDigest: digest,
    executionDefinition: agentExecution,
    executionDefinitionDigest: digest,
    toolId: "publication.create",
    toolVersion: "1.0.0",
    toolRegistrationDigest: digest,
    argumentsDigest: digest,
    targetDigest: digest,
    previewDigest: laterDigest,
    purpose,
    policyRegistrationDigest: digest,
  };

  it("round-trips a fully bound grant and rejects a missing binding", () => {
    const grant = roundTrip(CapabilityGrantSchema, {
      schemaVersion: "1",
      id: "grant-1",
      issuerId: "host-a",
      principal,
      tenant,
      workOrderId: "wo-1",
      workOrderBindingDigest: digest,
      executionDefinition: agentExecution,
      executionDefinitionDigest: digest,
      capability: "publication:write",
      action: "create",
      toolId: "publication.create",
      toolVersion: "1.0.0",
      toolRegistrationDigest: digest,
      normalizedResources: [resource],
      purpose,
      policyRegistrationDigest: digest,
      maximumUses: 1,
      issuedAt: now,
      expiresAt: later,
    });
    expect(grant.maximumUses).toBe(1);
    const { toolRegistrationDigest: _omitted, ...missingToolDigest } = grant;
    expect(_omitted).toBe(digest);
    expect(CapabilityGrantSchema.safeParse(missingToolDigest).success).toBe(false);
  });

  it("persists challenge proof only as a digest and approval as one exact use", () => {
    const challenge = roundTrip(DecisionSubmissionChallengeSchema, {
      schemaVersion: "1",
      id: "challenge-1",
      issuerId: "host-a",
      proofDigest: digest,
      binding: proposedEffect,
      requiredAuthenticationStrength: "user_presence",
      issuedAt: now,
      expiresAt: later,
    });
    expect(challenge).not.toHaveProperty("challengeProof");
    const approval = roundTrip(ApprovalSchema, {
      schemaVersion: "1",
      id: "approval-1",
      issuerId: "host-a",
      challengeId: challenge.id,
      challengeProofDigest: challenge.proofDigest,
      binding: proposedEffect,
      approvedBy: principal,
      authenticationStrength: "user_presence",
      createdAt: now,
      expiresAt: later,
      maximumUses: 1,
    });
    expect(approval.maximumUses).toBe(1);
    expect(ApprovalSchema.safeParse({ ...approval, maximumUses: 2 }).success).toBe(false);
  });

  it("requires a narrowed worker descriptor with no decision rights", () => {
    const descriptor = roundTrip(RunDelegationDescriptorSchema, {
      schemaVersion: "1",
      actor: { type: "system_worker", id: "worker-1" },
      initiatingPrincipal: principal,
      tenant,
      runId: "run-1",
      workOrderId: "wo-1",
      workOrderBindingDigest: digest,
      executionDefinition: agentExecution,
      executionDefinitionDigest: digest,
      purpose,
      maximumScopes: [resource],
      schedulerReceiptId: "receipt-1",
      schedulerReceiptDigest: digest,
      leaseId: "lease-1",
      fencingToken: 3,
      issuedAt: now,
      expiresAt: later,
      decisionRights: [],
    });
    expect(descriptor.decisionRights).toEqual([]);
    expect(
      RunDelegationDescriptorSchema.safeParse({ ...descriptor, decisionRights: ["approve"] })
        .success,
    ).toBe(false);
  });
});

describe("commands and reservations", () => {
  it("creates timestamped random IDs and canonical request digests", () => {
    const commandId = createCommandId({
      now: () => new Date(now),
      randomBytes: (length) => new Uint8Array(length).fill(0xab),
    });
    expect(commandId).toBe("kafcmd_1785758400000_abababababababababababababababab");
    const first = createCommandContext({
      commandId,
      operation: "run.start",
      payload: { b: 2, a: 1 },
    });
    const second = createCommandContext({
      commandId,
      operation: "run.start",
      payload: { a: 1, b: 2 },
    });
    expect(first.requestDigest).toBe(second.requestDigest);
    expect(() =>
      createCommandContext({
        commandId: "550e8400-e29b-41d4-a716-446655440000",
        operation: "run.start",
        payload: {},
      }),
    ).toThrow();
  });

  it("fails malformed, future-skewed, and horizon-expired command IDs closed", () => {
    const current = new Date(now);
    expect(
      validateCommandIdWindow("bad", {
        now: current,
        maximumFutureSkewMs: 1_000,
        idempotencyHorizonMs: 60_000,
      }),
    ).toMatchObject({ code: "KAF_COMMAND_ID_MALFORMED" });
    const future = createCommandId({
      now: () => new Date(current.getTime() + 2_000),
      randomBytes: (n) => new Uint8Array(n),
    });
    expect(
      validateCommandIdWindow(future, {
        now: current,
        maximumFutureSkewMs: 1_000,
        idempotencyHorizonMs: 60_000,
      }),
    ).toMatchObject({ code: "KAF_COMMAND_ID_FUTURE_SKEW" });
    const old = createCommandId({
      now: () => new Date(current.getTime() - 60_000),
      randomBytes: (n) => new Uint8Array(n),
    });
    expect(
      validateCommandIdWindow(old, {
        now: current,
        maximumFutureSkewMs: 1_000,
        idempotencyHorizonMs: 60_000,
      }),
    ).toMatchObject({ code: "KAF_COMMAND_IDEMPOTENCY_EXPIRED" });
  });

  it("round-trips command, admission, active execution, and model reservations", () => {
    const commandId = "kafcmd_1785758400000_00000000000000000000000000000000";
    const command = createCommandContext({
      commandId,
      operation: "run.start",
      payload: requestInput,
    });
    roundTrip(CommandRecordSchema, {
      schemaVersion: "1",
      scope: {
        issuerId: "host-a",
        tenant,
        principal,
        operation: command.operation,
        normalizedResourceScope: [],
        commandId,
      },
      requestDigest: command.requestDigest,
      status: "committed",
      resultReference: { kind: "run", runId: "run-1" },
      safeResponseDigest: digest,
      firstSeenAt: now,
      committedAt: now,
      detailRetentionExpiresAt: later,
      idempotencyExpiresAt: later,
    });
    roundTrip(AdmissionReservationSchema, {
      schemaVersion: "1",
      id: "admission-1",
      tenant,
      principal,
      commandId,
      category: "request_start",
      resourceKey: "agent:research-agent",
      amount: 1,
      state: "reserved",
      fencingToken: 1,
      reservedAtServerTime: now,
      leaseExpiresAt: later,
    });
    roundTrip(ActiveExecutionReservationSchema, {
      schemaVersion: "1",
      id: "active-1",
      tenant,
      runId: "run-1",
      stepId: "step-1",
      boundary: "model",
      boundaryKey: "model:1",
      leaseId: "lease-1",
      fencingToken: 1,
      startedAtServerTime: now,
      maxChargeMs: 10_000,
      state: "reserved",
      expiresAt: later,
    });
    roundTrip(ModelCallReservationSchema, {
      schemaVersion: "1",
      reservationId: "model-1",
      tenantId: tenant.id,
      runId: "run-1",
      stepId: "step-1",
      attempt: 1,
      workOrderBindingDigest: digest,
      agentDefinitionDigest: digest,
      modelSecurityProfileDigest: digest,
      modelResourceProfileDigest: digest,
      modelAdapterRegistrationDigest: digest,
      inputBytes: 1_024,
      inputTokenUpperBound: 512,
      outputTokenMaximum: 256,
      status: "accepted",
      createdAt: now,
      expiresAt: later,
    });
  });
});
