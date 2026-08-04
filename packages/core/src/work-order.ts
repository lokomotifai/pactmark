import { z } from "zod";

import { CompensationExecutionDefinitionRefSchema } from "./agent.js";
import { AgentExecutionDefinitionRefSchema } from "./model.js";
import { DigestSchema } from "./serialization.js";
import { PrincipalSchema, TenantSchema } from "./authority.js";

export const RiskClassSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const WorkModeSchema = z.enum([
  "assist",
  "augment",
  "automate",
  "apprenticeship_protected",
  "critical_human_decision",
]);
export type WorkMode = z.infer<typeof WorkModeSchema>;

export const AutonomyModeSchema = z.enum([
  "assist",
  "co_produce",
  "delegate_review",
  "exception_based",
  "closed_loop",
]);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

export const DataClassSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
  "highly_restricted",
]);
export type DataClass = z.infer<typeof DataClassSchema>;

export const PurposeSchema = z
  .object({
    code: z.string().trim().min(1).max(128),
    registryVersion: z.string().trim().min(1).max(128),
  })
  .strict();
export type Purpose = z.infer<typeof PurposeSchema>;

export const WorkContextSchema = z
  .object({
    roleFamily: z.string().trim().min(1).max(128),
    workflowId: z.string().trim().min(1).max(256),
    riskClass: RiskClassSchema,
  })
  .strict();
export type WorkContext = z.infer<typeof WorkContextSchema>;

export const RequestedDecisionOwnerSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("requesting_principal") }).strict(),
  z
    .object({
      mode: z.literal("registered_role"),
      role: z.string().trim().min(1).max(128),
    })
    .strict(),
]);
export type RequestedDecisionOwner = z.infer<typeof RequestedDecisionOwnerSchema>;

export const AcceptedDecisionOwnerSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("principal"),
      principal: PrincipalSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("registered_role"),
      role: z.string().trim().min(1).max(128),
    })
    .strict(),
]);
export type AcceptedDecisionOwner = z.infer<typeof AcceptedDecisionOwnerSchema>;

export const RetentionPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("session") }).strict(),
  z.object({ mode: z.literal("until"), expiresAt: z.iso.datetime({ offset: true }) }).strict(),
  z
    .object({ mode: z.literal("host_policy"), policyId: z.string().trim().min(1).max(256) })
    .strict(),
]);
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const ResourceScopeSchema = z
  .object({
    kind: z.string().trim().min(1).max(128),
    value: z.string().trim().min(1).max(2048),
    normalizationVersion: z.string().trim().min(1).max(64),
  })
  .strict();
export type ResourceScope = z.infer<typeof ResourceScopeSchema>;

const PositiveFiniteIntegerSchema = z.number().int().positive();
const NonnegativeFiniteSchema = z.number().nonnegative();

export const WorkBudgetSchema = z
  .object({
    maxTurns: PositiveFiniteIntegerSchema,
    maxModelCalls: PositiveFiniteIntegerSchema,
    maxToolCalls: PositiveFiniteIntegerSchema,
    maxActiveExecutionMs: PositiveFiniteIntegerSchema,
    maxModelInputBytesPerCall: PositiveFiniteIntegerSchema.optional(),
    maxModelInputTokensPerCall: PositiveFiniteIntegerSchema.optional(),
    maxModelOutputTokensPerCall: PositiveFiniteIntegerSchema.optional(),
    maxStreamedOutputBytesPerCall: PositiveFiniteIntegerSchema.optional(),
    maxStreamedOutputEventsPerCall: PositiveFiniteIntegerSchema.optional(),
    maxToolResultContextBytesPerCall: PositiveFiniteIntegerSchema.optional(),
    maxContextSnapshotBytes: PositiveFiniteIntegerSchema.optional(),
    maxRunModelInputBytes: PositiveFiniteIntegerSchema.optional(),
    maxRunModelOutputBytes: PositiveFiniteIntegerSchema.optional(),
    maxRunModelInputTokens: PositiveFiniteIntegerSchema.optional(),
    maxRunModelOutputTokens: PositiveFiniteIntegerSchema.optional(),
    maxRunToolResultContextBytes: PositiveFiniteIntegerSchema.optional(),
    monetaryCeiling: z
      .object({
        amount: NonnegativeFiniteSchema,
        currency: z.string().regex(/^[A-Z]{3}$/u),
        maximumPriceBoundVersion: z.string().trim().min(1).max(128),
        maximumPriceBoundExpiresAt: z.iso.datetime({ offset: true }),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorkBudget = z.infer<typeof WorkBudgetSchema>;

export const RequestedAgentSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    version: z.string().trim().min(1).max(128),
  })
  .strict();

export const WorkOrderRequestSchema = z
  .object({
    schemaVersion: z.literal("1").default("1"),
    agent: RequestedAgentSchema,
    goal: z.string().trim().min(1).max(32_768),
    input: z.json(),
    context: WorkContextSchema,
    workMode: WorkModeSchema,
    autonomyMode: AutonomyModeSchema,
    decisionOwner: RequestedDecisionOwnerSchema,
    purpose: PurposeSchema,
    dataClass: DataClassSchema,
    retention: RetentionPolicySchema,
    requestedCapabilities: z.array(z.string().trim().min(1).max(256)).max(256),
    resourceScopeCeiling: z.array(ResourceScopeSchema).max(256).default([]),
    budget: WorkBudgetSchema,
    workflowContext: z.record(z.string(), z.json()).optional(),
    correlationId: z.string().trim().min(1).max(256).optional(),
    deadline: z.iso.datetime({ offset: true }).optional(),
    region: z.string().trim().min(1).max(128).optional(),
    jurisdiction: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type WorkOrderRequest = z.infer<typeof WorkOrderRequestSchema>;

export function createWorkOrderRequest(input: unknown): WorkOrderRequest {
  return WorkOrderRequestSchema.parse(input);
}

const AcceptedWorkOrderCommonShape = {
  schemaVersion: z.literal("1"),
  id: z.string().trim().min(1).max(256),
  createdAt: z.iso.datetime({ offset: true }),
  goal: z.string().min(1).max(32_768),
  input: z.json(),
  context: WorkContextSchema,
  workMode: WorkModeSchema,
  autonomyMode: AutonomyModeSchema,
  decisionOwner: AcceptedDecisionOwnerSchema,
  purpose: PurposeSchema,
  dataClass: DataClassSchema,
  retention: RetentionPolicySchema,
  principal: PrincipalSchema,
  tenant: TenantSchema,
  requestedCapabilities: z.array(z.string().trim().min(1).max(256)).max(256),
  resourceScopeCeiling: z.array(ResourceScopeSchema).max(256),
  budget: WorkBudgetSchema,
  workflowContext: z.record(z.string(), z.json()).optional(),
  correlationId: z.string().trim().min(1).max(256).optional(),
  deadline: z.iso.datetime({ offset: true }).optional(),
  region: z.string().trim().min(1).max(128).optional(),
  jurisdiction: z.string().trim().min(1).max(128).optional(),
  workOrderBindingDigest: DigestSchema,
} as const;

export const AcceptedAgentWorkOrderSchema = z
  .object({
    ...AcceptedWorkOrderCommonShape,
    kind: z.literal("agent"),
    executionDefinition: AgentExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    modelSecurityProfileDigest: DigestSchema,
    modelResourceProfileDigest: DigestSchema,
    modelAdapterRegistrationDigest: DigestSchema,
  })
  .strict();
export type AcceptedAgentWorkOrder = z.infer<typeof AcceptedAgentWorkOrderSchema>;

export const AcceptedCompensationWorkOrderSchema = z
  .object({
    ...AcceptedWorkOrderCommonShape,
    kind: z.literal("compensation"),
    executionDefinition: CompensationExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    originalRunId: z.string().trim().min(1).max(256),
    originalEffectId: z.string().trim().min(1).max(256),
    originalEffectDigest: DigestSchema,
    originalEffectResultDigest: DigestSchema,
    originalEffectAcknowledgementDigest: DigestSchema,
    compensationStrategyRegistrationDigest: DigestSchema,
    compensationToolId: z.string().trim().min(1).max(256),
    compensationToolVersion: z.string().trim().min(1).max(128),
    compensationToolRegistrationDigest: DigestSchema,
  })
  .strict();
export type AcceptedCompensationWorkOrder = z.infer<typeof AcceptedCompensationWorkOrderSchema>;

export const AcceptedWorkOrderSchema = z.discriminatedUnion("kind", [
  AcceptedAgentWorkOrderSchema,
  AcceptedCompensationWorkOrderSchema,
]);
export type AcceptedWorkOrder = z.infer<typeof AcceptedWorkOrderSchema>;

export const WorkOrderBindingDigestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    workOrderId: z.string().trim().min(1).max(256),
    digest: DigestSchema,
  })
  .strict();
export type WorkOrderBindingDigest = z.infer<typeof WorkOrderBindingDigestSchema>;
