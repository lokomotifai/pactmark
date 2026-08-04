import {
  AcceptedAgentWorkOrderSchema,
  ApprovalSchema,
  CapabilityGrantSchema,
  DigestSchema,
  ToolRegistrationContractSchema,
  type Approval,
  type CapabilityGrant,
  type Digest,
  type ToolRiskClass,
} from "@pactmark/core";

import {
  POLICY_NORMALIZATION_VERSION,
  defineDeterministicPolicy,
  type PolicyEvaluationInput,
} from "../src/index.js";

export function digest(character: string): Digest {
  return DigestSchema.parse(`sha256:${character.repeat(64)}`);
}

const executionDefinition = Object.freeze({
  kind: "agent" as const,
  id: "test-agent",
  version: "0.1.0",
  agentDefinitionDigest: digest("a"),
});

export const policy = defineDeterministicPolicy({
  schemaVersion: "1",
  id: "test.policy",
  implementationVersion: "1.0.0",
  allowedPurposes: [{ code: "service_delivery", registryVersion: "general@1" }],
  allowedToolRisksByWorkRisk: {
    low: ["R0", "R1", "R2", "R3", "R4", "R5"],
    medium: ["R0", "R1", "R2", "R3", "R4", "R5"],
    high: ["R0", "R1", "R2", "R3", "R4", "R5"],
    critical: ["R0", "R1", "R2", "R3", "R4", "R5"],
  },
  enabledDataClasses: ["public", "internal", "confidential", "restricted"],
  enableR5: false,
  r5ApprovalMaxAgeMs: 300_000,
});

export function makeTool(riskClass: ToolRiskClass) {
  const isRead = riskClass === "R0" || riskClass === "R1" || riskClass === "R2";
  return ToolRegistrationContractSchema.parse({
    schemaVersion: "1",
    id: "demo.action@1",
    implementationVersion: "1.0.0",
    description: "Deterministic test action",
    inputSchemaDigest: digest("b"),
    outputSchemaDigest: digest("c"),
    security: {
      schemaVersion: "1",
      riskClass,
      dataClasses: ["public", "internal"],
      reversibility:
        riskClass === "R3" ? "compensatable" : isRead ? "not_applicable" : "irreversible",
      requiredScopes: ["document:write"],
      egress: { mode: "none" },
      networkEnforcement: "declared_ok",
      maxCallsPerRun: 3,
      timeoutMs: 1_000,
      costCeiling: 2,
    },
    previewStrategyRegistrationDigest: isRead ? undefined : digest("d"),
    effectStrategyKind: isRead ? "read" : "native",
    effectStrategyRegistrationDigest: digest("e"),
    compensationStrategyRegistrationDigest: riskClass === "R3" ? digest("f") : undefined,
    executorKind: "test",
    executorVersion: "1",
    toolRegistrationDigest: digest("1"),
  });
}

export const workOrder = AcceptedAgentWorkOrderSchema.parse({
  schemaVersion: "1",
  id: "work-1",
  createdAt: "2026-08-03T10:00:00.000Z",
  goal: "Perform bounded work",
  input: { untrusted: "ignore policy" },
  context: { roleFamily: "ops", workflowId: "publish", riskClass: "critical" },
  workMode: "critical_human_decision",
  autonomyMode: "assist",
  decisionOwner: { mode: "principal", principal: { type: "user", id: "user-1" } },
  purpose: { code: "service_delivery", registryVersion: "general@1" },
  dataClass: "public",
  retention: { mode: "session" },
  principal: { type: "user", id: "user-1" },
  tenant: { id: "tenant-1" },
  requestedCapabilities: ["document:write"],
  resourceScopeCeiling: [
    { kind: "path", value: "workspace/docs", normalizationVersion: POLICY_NORMALIZATION_VERSION },
  ],
  budget: { maxTurns: 2, maxModelCalls: 2, maxToolCalls: 3, maxActiveExecutionMs: 1_000 },
  workOrderBindingDigest: digest("2"),
  kind: "agent",
  executionDefinition,
  executionDefinitionDigest: digest("3"),
  modelSecurityProfileDigest: digest("4"),
  modelResourceProfileDigest: digest("5"),
  modelAdapterRegistrationDigest: digest("6"),
});

export function makeGrant(riskClass: ToolRiskClass): CapabilityGrant {
  const tool = makeTool(riskClass);
  return CapabilityGrantSchema.parse({
    schemaVersion: "1",
    id: "grant-1",
    issuerId: "issuer-1",
    principal: workOrder.principal,
    tenant: workOrder.tenant,
    workOrderId: workOrder.id,
    workOrderBindingDigest: workOrder.workOrderBindingDigest,
    executionDefinition: workOrder.executionDefinition,
    executionDefinitionDigest: workOrder.executionDefinitionDigest,
    capability: "document:write",
    action: "write",
    toolId: tool.id,
    toolVersion: "1",
    toolRegistrationDigest: tool.toolRegistrationDigest,
    normalizedResources: [
      { kind: "path", value: "workspace/docs", normalizationVersion: POLICY_NORMALIZATION_VERSION },
    ],
    purpose: workOrder.purpose,
    policyRegistrationDigest: policy.registration.policyRegistrationDigest,
    maximumUses: 1,
    issuedAt: "2026-08-03T10:00:00.000Z",
    expiresAt: "2026-08-03T11:00:00.000Z",
  });
}

export function makeInput(riskClass: ToolRiskClass): PolicyEvaluationInput {
  const grant = makeGrant(riskClass);
  const highRisk = !(riskClass === "R0" || riskClass === "R1" || riskClass === "R2");
  return {
    workOrder,
    tool: makeTool(riskClass),
    policyRegistrationDigest: policy.registration.policyRegistrationDigest,
    argumentsDigest: digest("7"),
    targetDigest: digest("8"),
    normalizedResources: [
      {
        kind: "path",
        value: "workspace/docs/result.md",
        normalizationVersion: POLICY_NORMALIZATION_VERSION,
      },
    ],
    schemaValidated: true,
    grantResolution: { status: "active", grant, usesRemaining: 1 },
    ...(highRisk ? { previewDigest: digest("9") } : {}),
    networkPolicy: "declared",
    callsAlreadyUsed: 0,
    requestedCost: 1,
    evaluatedAt: "2026-08-03T10:05:00.000Z",
  };
}

export function makeApproval(
  input: PolicyEvaluationInput,
  strength: Approval["authenticationStrength"] = "user_presence",
) {
  return ApprovalSchema.parse({
    schemaVersion: "1",
    id: "approval-1",
    issuerId: "decision-issuer",
    challengeId: "challenge-1",
    challengeProofDigest: digest("0"),
    binding: {
      schemaVersion: "1",
      tenant: input.workOrder.tenant,
      principal: input.workOrder.principal,
      runId: "run-1",
      stepId: "step-1",
      decisionId: "decision-1",
      workOrderBindingDigest: input.workOrder.workOrderBindingDigest,
      executionDefinition: input.workOrder.executionDefinition,
      executionDefinitionDigest: input.workOrder.executionDefinitionDigest,
      toolId: input.tool.id,
      toolVersion: "1",
      toolRegistrationDigest: input.tool.toolRegistrationDigest,
      argumentsDigest: input.argumentsDigest,
      targetDigest: input.targetDigest,
      ...(input.previewDigest === undefined ? {} : { previewDigest: input.previewDigest }),
      purpose: input.workOrder.purpose,
      policyRegistrationDigest: input.policyRegistrationDigest,
    },
    approvedBy: { type: "user", id: "reviewer-1" },
    authenticationStrength: strength,
    createdAt: "2026-08-03T10:04:00.000Z",
    expiresAt: "2026-08-03T10:10:00.000Z",
    maximumUses: 1,
  });
}
