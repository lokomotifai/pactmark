import { z } from "zod";

export const POLICY_REASON_CODES = [
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
] as const;

export const PolicyReasonCodeSchema = z.enum(POLICY_REASON_CODES);
export type PolicyReasonCode = z.infer<typeof PolicyReasonCodeSchema>;

export const PolicyDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      schemaVersion: z.literal("1"),
      decision: z.literal("deny"),
      reasonCode: PolicyReasonCodeSchema,
      waivable: z.literal(false),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("1"),
      decision: z.literal("allow_with_grant"),
      reasonCode: z.literal("KAF_POLICY_ALLOWED"),
      waivable: z.literal(false),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("1"),
      decision: z.literal("require_approval"),
      reasonCode: z.literal("KAF_POLICY_APPROVAL_REQUIRED"),
      waivable: z.literal(false),
    })
    .strict(),
]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export function deny(reasonCode: Exclude<PolicyReasonCode, "KAF_POLICY_ALLOWED">): PolicyDecision {
  return Object.freeze({ schemaVersion: "1", decision: "deny", reasonCode, waivable: false });
}

export const allow = (): PolicyDecision =>
  Object.freeze({
    schemaVersion: "1",
    decision: "allow_with_grant",
    reasonCode: "KAF_POLICY_ALLOWED",
    waivable: false,
  });

export const requireApproval = (): PolicyDecision =>
  Object.freeze({
    schemaVersion: "1",
    decision: "require_approval",
    reasonCode: "KAF_POLICY_APPROVAL_REQUIRED",
    waivable: false,
  });
