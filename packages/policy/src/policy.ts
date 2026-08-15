import {
  AcceptedWorkOrderSchema,
  ApprovalSchema,
  CapabilityGrantSchema,
  ToolRegistrationContractSchema,
  definePolicyRegistration,
  digestCanonicalJson,
  type AcceptedWorkOrder,
  type Approval,
  type CapabilityGrant,
  type CapabilityGrantResolution,
  type Digest,
  type PolicyEngine,
  type PolicyRegistration,
  type ResourceScope,
  type ToolRegistrationContract,
} from "@pactmark/core";
import { z } from "zod";

import { canonicalizeResourceScope, isResourceWithinScope } from "./canonicalization.js";
import type { KillSwitchRegistry } from "./kill-switch.js";
import {
  allow,
  deny,
  requireApproval,
  type PolicyDecision,
  type PolicyReasonCode,
} from "./reason-codes.js";

const RiskListSchema = z.array(z.enum(["R0", "R1", "R2", "R3", "R4", "R5"])).min(1);

export const DeterministicPolicyConfigSchema = z
  .object({
    schemaVersion: z.literal("1"),
    id: z.string().min(1).max(250),
    implementationVersion: z.string().min(1).max(100),
    allowedPurposes: z.array(
      z.object({ code: z.string().min(1), registryVersion: z.string().min(1) }).strict(),
    ),
    allowedToolRisksByWorkRisk: z
      .object({
        low: RiskListSchema,
        medium: RiskListSchema,
        high: RiskListSchema,
        critical: RiskListSchema,
      })
      .strict(),
    enabledDataClasses: z.array(
      z.enum(["public", "internal", "confidential", "restricted", "highly_restricted"]),
    ),
    enableR5: z.boolean(),
    r5ApprovalMaxAgeMs: z.number().int().positive(),
  })
  .strict();
export type DeterministicPolicyConfig = z.infer<typeof DeterministicPolicyConfigSchema>;

export const DEFAULT_POLICY_CONFIG = Object.freeze(
  DeterministicPolicyConfigSchema.parse({
    schemaVersion: "1",
    id: "pactmark.default-deny",
    implementationVersion: "1.0.0",
    allowedPurposes: [],
    allowedToolRisksByWorkRisk: {
      low: ["R0", "R1", "R2"],
      medium: ["R0", "R1", "R2", "R3"],
      high: ["R0", "R1", "R2", "R3", "R4"],
      critical: ["R0", "R1", "R2", "R3", "R4"],
    },
    enabledDataClasses: ["public", "internal", "confidential", "restricted"],
    enableR5: false,
    r5ApprovalMaxAgeMs: 5 * 60 * 1000,
  }),
);

export function defineDeterministicPolicy(
  input: DeterministicPolicyConfig,
): Readonly<{ config: DeterministicPolicyConfig; registration: PolicyRegistration }> {
  const config = Object.freeze(DeterministicPolicyConfigSchema.parse(input));
  const registration = definePolicyRegistration({
    id: config.id,
    implementationVersion: config.implementationVersion,
    defaultDecision: "deny",
    rules: {
      allowedPurposes: config.allowedPurposes,
      allowedToolRisksByWorkRisk: config.allowedToolRisksByWorkRisk,
      enabledDataClasses: config.enabledDataClasses,
      enableR5: config.enableR5,
      r5ApprovalMaxAgeMs: config.r5ApprovalMaxAgeMs,
    },
    config: { normalization: "pactmark.policy-normalization@1" },
    schemaIdentityDigests: [],
    reasonCodes: [
      "KAF_POLICY_ALLOWED",
      "KAF_POLICY_DEFAULT_DENY",
      "KAF_POLICY_INVALID_INPUT",
      "KAF_POLICY_UNKNOWN_PURPOSE",
      "KAF_POLICY_DATA_CLASS_DENIED",
      "KAF_POLICY_CAPABILITY_DENIED",
      "KAF_POLICY_SCOPE_DENIED",
      "KAF_POLICY_GRANT_REQUIRED",
      "KAF_POLICY_GRANT_BINDING_MISMATCH",
      "KAF_POLICY_SCHEMA_REQUIRED",
      "KAF_POLICY_PREVIEW_REQUIRED",
      "KAF_POLICY_COMPENSATION_REQUIRED",
      "KAF_POLICY_EFFECT_STRATEGY_REQUIRED",
      "KAF_POLICY_APPROVAL_REQUIRED",
      "KAF_POLICY_APPROVAL_INVALID",
      "KAF_POLICY_R5_DISABLED",
      "KAF_POLICY_NETWORK_ENFORCEMENT_REQUIRED",
      "KAF_POLICY_BUDGET_EXCEEDED",
      "KAF_POLICY_REGISTRATION_KILLED",
    ],
    executorIdentity: {
      package: "@pactmark/policy",
      export: "evaluatePolicy",
      version: config.implementationVersion,
    },
  });
  return Object.freeze({ config, registration });
}

export type PolicyEvaluationInput = Readonly<{
  workOrder: AcceptedWorkOrder;
  tool: ToolRegistrationContract;
  policyRegistrationDigest: Digest;
  argumentsDigest: Digest;
  targetDigest: Digest;
  normalizedResources: readonly ResourceScope[];
  schemaValidated: boolean;
  grantResolution?: CapabilityGrantResolution;
  approval?: Approval;
  runId: string;
  stepId: string;
  decisionId: string;
  previewDigest?: Digest;
  networkPolicy: "none" | "declared" | "enforced";
  callsAlreadyUsed: number;
  requestedCost?: number;
  evaluatedAt: string;
}>;

function purposeAllowed(config: DeterministicPolicyConfig, workOrder: AcceptedWorkOrder): boolean {
  return config.allowedPurposes.some(
    (purpose) =>
      purpose.code === workOrder.purpose.code &&
      purpose.registryVersion === workOrder.purpose.registryVersion,
  );
}

function scopesAllowed(
  candidates: readonly ResourceScope[],
  ceilings: readonly ResourceScope[],
): boolean {
  return candidates.every((candidate) =>
    ceilings.some((ceiling) => isResourceWithinScope(candidate, ceiling)),
  );
}

function grantMatches(
  grant: CapabilityGrant,
  input: PolicyEvaluationInput,
  resources: readonly ResourceScope[],
): boolean {
  const subject = input.workOrder.principal;
  return (
    grant.tenant.id === input.workOrder.tenant.id &&
    grant.principal.type === subject.type &&
    grant.principal.id === subject.id &&
    grant.workOrderId === input.workOrder.id &&
    grant.workOrderBindingDigest === input.workOrder.workOrderBindingDigest &&
    grant.executionDefinitionDigest === input.workOrder.executionDefinitionDigest &&
    grant.toolId === input.tool.id &&
    grant.toolRegistrationDigest === input.tool.toolRegistrationDigest &&
    grant.policyRegistrationDigest === input.policyRegistrationDigest &&
    grant.action === (input.tool.effectStrategyKind === "read" ? "read" : "write") &&
    grant.purpose.code === input.workOrder.purpose.code &&
    grant.purpose.registryVersion === input.workOrder.purpose.registryVersion &&
    input.tool.security.requiredScopes.includes(grant.capability) &&
    scopesAllowed(resources, grant.normalizedResources)
  );
}

function approvalMatches(approvalInput: Approval, input: PolicyEvaluationInput): boolean {
  let approval: Approval;
  try {
    approval = ApprovalSchema.parse(approvalInput);
  } catch {
    return false;
  }
  const binding = approval.binding;
  return (
    Date.parse(input.evaluatedAt) < Date.parse(approval.expiresAt) &&
    approval.approvedBy.type !== "system_worker" &&
    binding.tenant.id === input.workOrder.tenant.id &&
    binding.principal.type === input.workOrder.principal.type &&
    binding.principal.id === input.workOrder.principal.id &&
    binding.runId === input.runId &&
    binding.stepId === input.stepId &&
    binding.decisionId === input.decisionId &&
    binding.workOrderBindingDigest === input.workOrder.workOrderBindingDigest &&
    binding.executionDefinitionDigest === input.workOrder.executionDefinitionDigest &&
    binding.toolId === input.tool.id &&
    binding.toolRegistrationDigest === input.tool.toolRegistrationDigest &&
    binding.argumentsDigest === input.argumentsDigest &&
    binding.targetDigest === input.targetDigest &&
    binding.previewDigest === input.previewDigest &&
    binding.policyRegistrationDigest === input.policyRegistrationDigest &&
    binding.purpose.code === input.workOrder.purpose.code &&
    binding.purpose.registryVersion === input.workOrder.purpose.registryVersion
  );
}

function hasWriteStrategy(tool: ToolRegistrationContract): boolean {
  return tool.effectStrategyKind !== "read";
}

export type PolicyPreflightInput = Readonly<{
  workOrder: AcceptedWorkOrder;
  tool: ToolRegistrationContract;
  policyRegistrationDigest: Digest;
  argumentsDigest: Digest;
  resources: readonly ResourceScope[];
  schemaValidated: boolean;
  networkPolicy: "none" | "declared" | "enforced";
  callsAlreadyUsed: number;
  requestedCost?: number;
}>;

export type PolicyPreflightResult =
  | Readonly<{
      decision: "deny";
      reasonCode: Exclude<PolicyReasonCode, "KAF_POLICY_ALLOWED">;
    }>
  | Readonly<{
      decision: "pass";
      reasonCode: "KAF_POLICY_ALLOWED";
      normalizedResources: readonly ResourceScope[];
      normalizedTargetDigest: Digest;
      approvalRequired: boolean;
    }>;

function preflightDeny(
  reasonCode: Exclude<PolicyReasonCode, "KAF_POLICY_ALLOWED">,
): PolicyPreflightResult {
  return Object.freeze({ decision: "deny", reasonCode });
}

/** Shared fail-closed boundary used by both the portable evaluator and runtime adapters. */
export function evaluatePolicyPreflight(
  configInput: DeterministicPolicyConfig,
  inputRaw: PolicyPreflightInput,
  killSwitches?: KillSwitchRegistry,
): PolicyPreflightResult {
  let config: DeterministicPolicyConfig;
  let workOrder: AcceptedWorkOrder;
  let tool: ToolRegistrationContract;
  try {
    config = DeterministicPolicyConfigSchema.parse(configInput);
    workOrder = AcceptedWorkOrderSchema.parse(inputRaw.workOrder);
    tool = ToolRegistrationContractSchema.parse(inputRaw.tool);
  } catch {
    return preflightDeny("KAF_POLICY_INVALID_INPUT");
  }
  if (
    killSwitches?.isKilled("tool_registration", tool.toolRegistrationDigest) === true ||
    killSwitches?.isKilled("policy_registration", inputRaw.policyRegistrationDigest) === true
  ) {
    return preflightDeny("KAF_POLICY_REGISTRATION_KILLED");
  }
  if (!purposeAllowed(config, workOrder)) return preflightDeny("KAF_POLICY_UNKNOWN_PURPOSE");
  if (
    !config.enabledDataClasses.includes(workOrder.dataClass) ||
    !tool.security.dataClasses.includes(workOrder.dataClass)
  ) {
    return preflightDeny("KAF_POLICY_DATA_CLASS_DENIED");
  }
  if (
    !config.allowedToolRisksByWorkRisk[workOrder.context.riskClass].includes(
      tool.security.riskClass,
    )
  ) {
    return preflightDeny("KAF_POLICY_DEFAULT_DENY");
  }
  if (!inputRaw.schemaValidated) return preflightDeny("KAF_POLICY_SCHEMA_REQUIRED");
  if (
    tool.security.requiredScopes.length === 0 ||
    !tool.security.requiredScopes.every((scope) => workOrder.requestedCapabilities.includes(scope))
  ) {
    return preflightDeny("KAF_POLICY_CAPABILITY_DENIED");
  }
  let normalizedResources: readonly ResourceScope[];
  try {
    normalizedResources = inputRaw.resources.map(canonicalizeResourceScope);
  } catch {
    return preflightDeny("KAF_POLICY_SCOPE_DENIED");
  }
  if (
    normalizedResources.length === 0 ||
    !scopesAllowed(normalizedResources, workOrder.resourceScopeCeiling)
  ) {
    return preflightDeny("KAF_POLICY_SCOPE_DENIED");
  }
  if (inputRaw.callsAlreadyUsed >= tool.security.maxCallsPerRun) {
    return preflightDeny("KAF_POLICY_BUDGET_EXCEEDED");
  }
  if (
    inputRaw.requestedCost !== undefined &&
    (tool.security.costCeiling === undefined || inputRaw.requestedCost > tool.security.costCeiling)
  ) {
    return preflightDeny("KAF_POLICY_BUDGET_EXCEEDED");
  }
  if (tool.security.networkEnforcement === "required" && inputRaw.networkPolicy !== "enforced") {
    return preflightDeny("KAF_POLICY_NETWORK_ENFORCEMENT_REQUIRED");
  }
  const normalizedTargetDigest = digestCanonicalJson({
    schemaVersion: "1",
    resources: normalizedResources,
  });
  return Object.freeze({
    decision: "pass",
    reasonCode: "KAF_POLICY_ALLOWED",
    normalizedResources: Object.freeze([...normalizedResources]),
    normalizedTargetDigest,
    approvalRequired: tool.security.riskClass === "R4" || tool.security.riskClass === "R5",
  });
}

export function evaluatePolicy(
  configInput: DeterministicPolicyConfig,
  inputRaw: PolicyEvaluationInput,
  killSwitches?: KillSwitchRegistry,
): PolicyDecision {
  let config: DeterministicPolicyConfig;
  let workOrder: AcceptedWorkOrder;
  let tool: ToolRegistrationContract;
  try {
    config = DeterministicPolicyConfigSchema.parse(configInput);
    workOrder = AcceptedWorkOrderSchema.parse(inputRaw.workOrder);
    tool = ToolRegistrationContractSchema.parse(inputRaw.tool);
  } catch {
    return deny("KAF_POLICY_INVALID_INPUT");
  }
  const input: PolicyEvaluationInput = { ...inputRaw, workOrder, tool };
  const preflight = evaluatePolicyPreflight(
    config,
    {
      workOrder,
      tool,
      policyRegistrationDigest: input.policyRegistrationDigest,
      argumentsDigest: input.argumentsDigest,
      resources: input.normalizedResources,
      schemaValidated: input.schemaValidated,
      networkPolicy: input.networkPolicy,
      callsAlreadyUsed: input.callsAlreadyUsed,
      ...(input.requestedCost === undefined ? {} : { requestedCost: input.requestedCost }),
    },
    killSwitches,
  );
  if (preflight.decision === "deny") return deny(preflight.reasonCode);
  const resources = preflight.normalizedResources;
  if (input.grantResolution === undefined) return deny("KAF_POLICY_GRANT_REQUIRED");
  if (input.grantResolution.status !== "active") {
    return deny(
      input.grantResolution.status === "binding_mismatch"
        ? "KAF_POLICY_GRANT_BINDING_MISMATCH"
        : "KAF_POLICY_GRANT_REQUIRED",
    );
  }
  if (!grantMatches(CapabilityGrantSchema.parse(input.grantResolution.grant), input, resources)) {
    return deny("KAF_POLICY_GRANT_BINDING_MISMATCH");
  }

  const risk = tool.security.riskClass;
  if (risk === "R0" || risk === "R1" || risk === "R2") return allow();
  if (input.previewDigest === undefined || tool.previewStrategyRegistrationDigest === undefined) {
    return deny("KAF_POLICY_PREVIEW_REQUIRED");
  }
  if (!hasWriteStrategy(tool)) return deny("KAF_POLICY_EFFECT_STRATEGY_REQUIRED");
  if (
    risk === "R3" &&
    (tool.security.reversibility !== "compensatable" ||
      tool.compensationStrategyRegistrationDigest === undefined)
  ) {
    return deny("KAF_POLICY_COMPENSATION_REQUIRED");
  }
  if (risk === "R3") return allow();
  if (risk === "R5" && !config.enableR5) return deny("KAF_POLICY_R5_DISABLED");
  if (input.approval === undefined) return requireApproval();
  if (!approvalMatches(input.approval, input)) return deny("KAF_POLICY_APPROVAL_INVALID");
  const approvalStrength = {
    single_factor: 0,
    multi_factor: 1,
    phishing_resistant: 2,
    user_presence: 3,
  } as const;
  if (risk === "R4" && approvalStrength[input.approval.authenticationStrength] < 2) {
    return deny("KAF_POLICY_APPROVAL_INVALID");
  }
  if (
    risk === "R5" &&
    (input.approval.authenticationStrength !== "user_presence" ||
      Date.parse(input.evaluatedAt) - Date.parse(input.approval.createdAt) >
        config.r5ApprovalMaxAgeMs)
  ) {
    return deny("KAF_POLICY_APPROVAL_INVALID");
  }
  return allow();
}

/**
 * Preliminary core port adapter. It never dispatches and deliberately cannot
 * turn its result into authority; runtime still resolves and reserves a grant.
 */
export function createPolicyEngine(
  policy: ReturnType<typeof defineDeterministicPolicy>,
  killSwitches?: KillSwitchRegistry,
): PolicyEngine {
  const engine: PolicyEngine = {
    evaluate(input: Parameters<PolicyEngine["evaluate"]>[0]) {
      const result = evaluatePolicyPreflight(
        policy.config,
        {
          ...input,
          policyRegistrationDigest: policy.registration.policyRegistrationDigest,
        },
        killSwitches,
      );
      if (result.decision === "deny") return Promise.resolve(result);
      return Promise.resolve({
        decision: result.approvalRequired
          ? ("require_approval" as const)
          : ("allow_with_grant" as const),
        reasonCode: result.approvalRequired ? "KAF_POLICY_APPROVAL_REQUIRED" : "KAF_POLICY_ALLOWED",
        normalizedResources: result.normalizedResources,
        normalizedTargetDigest: result.normalizedTargetDigest,
      });
    },
  };
  return Object.freeze(engine);
}
