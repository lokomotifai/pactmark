import { z } from "zod";
import { ExecutionDefinitionRefSchema } from "./agent.js";
import { ProtectedValueRefSchema } from "./context.js";
import { canonicalJsonStringify, DigestSchema, JsonValueSchema } from "./serialization.js";
import { DataClassSchema, WorkBudgetSchema } from "./work-order.js";

export const EffectStrategyKindSchema = z.enum(["native", "transactional", "reconcilable", "none"]);
export type EffectStrategyKind = z.infer<typeof EffectStrategyKindSchema>;
export const EffectStateSchema = z.enum([
  "prepared",
  "dispatched",
  "unknown",
  "needs_reconciliation",
  "acknowledged",
  "abandoned",
  "compensated",
]);
export type EffectState = z.infer<typeof EffectStateSchema>;

export const RuntimeCompensationRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    reason: z.string().trim().min(1).max(512),
    budget: WorkBudgetSchema,
  })
  .strict();
export type RuntimeCompensationRequest = z.infer<typeof RuntimeCompensationRequestSchema>;

export const EffectAcknowledgementSchema = z
  .object({
    schemaVersion: z.literal("1"),
    acknowledgementId: z.string().min(1),
    proofKind: z.enum([
      "receiver_receipt",
      "transaction_commit",
      "successful_response",
      "lookup_recovery",
    ]),
    effectKey: z.string().min(1),
    operationKey: z.string().min(1).optional(),
    toolRegistrationDigest: DigestSchema,
    strategyRegistrationDigest: DigestSchema,
    normalizedTargetDigest: DigestSchema,
    resultSchemaDigest: DigestSchema,
    resultDigest: DigestSchema,
    proofDigest: DigestSchema,
    safeReceiptMetadata: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    acknowledgedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type EffectAcknowledgement = z.infer<typeof EffectAcknowledgementSchema>;

export const EffectExecutionResultSchema = z
  .object({
    schemaVersion: z.literal("1"),
    result: JsonValueSchema,
    acknowledgement: EffectAcknowledgementSchema,
  })
  .strict();
export type EffectExecutionResult = z.infer<typeof EffectExecutionResultSchema>;

const EffectRecordBaseSchema = z.object({
  schemaVersion: z.literal("1"),
  effectId: z.string().min(1),
  effectDigest: DigestSchema,
  tenantId: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  toolCallId: z.string().min(1),
  effectKey: z.string().min(1),
  operationKey: z.string().min(1).optional(),
  executionDefinition: ExecutionDefinitionRefSchema,
  executionDefinitionDigest: DigestSchema,
  workOrderBindingDigest: DigestSchema,
  toolId: z.string().min(1),
  toolVersion: z.string().min(1),
  toolRegistrationDigest: DigestSchema,
  strategy: EffectStrategyKindSchema,
  strategyRegistrationDigest: DigestSchema,
  authorizationReservationId: z.string().min(1),
  argumentsDigest: DigestSchema,
  normalizedTargetDigest: DigestSchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const EffectRecordSchema = z.discriminatedUnion("state", [
  EffectRecordBaseSchema.extend({ state: z.literal("prepared") }).strict(),
  EffectRecordBaseSchema.extend({
    state: z.literal("dispatched"),
    dispatchedAt: z.iso.datetime({ offset: true }),
  }).strict(),
  EffectRecordBaseSchema.extend({
    state: z.literal("unknown"),
    dispatchedAt: z.iso.datetime({ offset: true }),
    uncertaintyCode: z.string().min(1),
  }).strict(),
  EffectRecordBaseSchema.extend({
    state: z.literal("needs_reconciliation"),
    uncertaintyCode: z.string().min(1),
    effectMayHaveOccurred: z.literal(true),
  }).strict(),
  EffectRecordBaseSchema.extend({
    state: z.literal("acknowledged"),
    resultDigest: DigestSchema,
    acknowledgement: EffectAcknowledgementSchema,
  }).strict(),
  EffectRecordBaseSchema.extend({
    state: z.literal("abandoned"),
    reason: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
    effectMayHaveOccurred: z.literal(true),
  }).strict(),
  EffectRecordBaseSchema.extend({
    state: z.literal("compensated"),
    resultDigest: DigestSchema,
    acknowledgement: EffectAcknowledgementSchema,
    compensationRunId: z.string().min(1),
    compensationEffectDigest: DigestSchema,
  }).strict(),
]);
export type EffectRecord = z.infer<typeof EffectRecordSchema>;

/**
 * Protected, transactionally persisted result for an acknowledged effect.
 * The result itself is never stored in plaintext in the event or effect ledger.
 */
export const ProtectedEffectResultRecordSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenantId: z.string().min(1),
    runId: z.string().min(1),
    effectId: z.string().min(1),
    effectDigest: DigestSchema,
    resultDigest: DigestSchema,
    byteSize: z.number().int().nonnegative(),
    workOrderId: z.string().min(1),
    workOrderBindingDigest: DigestSchema,
    executionDefinition: ExecutionDefinitionRefSchema,
    executionDefinitionDigest: DigestSchema,
    toolId: z.string().min(1),
    toolVersion: z.string().min(1),
    toolRegistrationDigest: DigestSchema,
    strategy: EffectStrategyKindSchema,
    strategyRegistrationDigest: DigestSchema,
    resultSchemaDigest: DigestSchema,
    purposeCode: z.string().min(1),
    purposeRegistryVersion: z.string().min(1),
    dataClass: DataClassSchema.exclude(["highly_restricted"]),
    protectedValue: ProtectedValueRefSchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ProtectedEffectResultRecord = z.infer<typeof ProtectedEffectResultRecordSchema>;
export type ProtectedEffectResultAadRecord = Omit<ProtectedEffectResultRecord, "protectedValue">;

/** Canonical AAD shared by result writers and readers. */
export function protectedEffectResultAad(
  record: ProtectedEffectResultRecord | ProtectedEffectResultAadRecord,
): Readonly<Record<string, string>> {
  return {
    storeKind: "acknowledged_effect_result",
    schemaVersion: record.schemaVersion,
    tenantId: record.tenantId,
    runId: record.runId,
    effectId: record.effectId,
    recordId: record.effectId,
    effectDigest: record.effectDigest,
    resultDigest: record.resultDigest,
    byteSize: String(record.byteSize),
    workOrderId: record.workOrderId,
    workOrderBindingDigest: record.workOrderBindingDigest,
    executionDefinition: canonicalJsonStringify(record.executionDefinition),
    executionDefinitionDigest: record.executionDefinitionDigest,
    toolId: record.toolId,
    toolVersion: record.toolVersion,
    toolRegistrationDigest: record.toolRegistrationDigest,
    strategy: record.strategy,
    strategyRegistrationDigest: record.strategyRegistrationDigest,
    resultSchemaDigest: record.resultSchemaDigest,
    purposeCode: record.purposeCode,
    purposeRegistryVersion: record.purposeRegistryVersion,
    dataClass: record.dataClass,
    createdAt: record.createdAt,
  };
}

export const EFFECT_TRANSITIONS = {
  prepared: ["dispatched"],
  dispatched: ["acknowledged", "unknown"],
  unknown: ["needs_reconciliation"],
  needs_reconciliation: ["acknowledged", "abandoned"],
  acknowledged: ["compensated"],
  abandoned: [],
  compensated: [],
} as const satisfies Readonly<Record<EffectState, readonly EffectState[]>>;

export function isEffectTransitionAllowed(
  from: EffectState,
  to: EffectState,
  strategy: EffectStrategyKind,
): boolean {
  if (strategy === "transactional") return to === "acknowledged" && from === "prepared";
  return (EFFECT_TRANSITIONS[from] as readonly EffectState[]).includes(to);
}

export const EffectReconciliationResolutionSchema = z.discriminatedUnion("kind", [
  z
    .object({ schemaVersion: z.literal("1"), kind: z.literal("recovered_acknowledgement") })
    .strict(),
  z
    .object({
      schemaVersion: z.literal("1"),
      kind: z.literal("abandon_uncertain"),
      reason: z.string().min(1),
      evidenceRefs: z.array(z.string().min(1)),
      effectMayHaveOccurred: z.literal(true),
    })
    .strict(),
]);
export type EffectReconciliationResolution = z.infer<typeof EffectReconciliationResolutionSchema>;
