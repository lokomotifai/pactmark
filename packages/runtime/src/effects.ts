import {
  AuthorizationReservationSchema,
  EffectAcknowledgementSchema,
  EffectExecutionResultSchema,
  EffectPreviewSchema,
  EffectRecordSchema,
  WorkBudgetSchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  KafError,
  type AcceptedWorkOrder,
  type CompensationRunDefinition,
  type CompensationRunRegistry,
  type AuthorizationReservation,
  type Digest,
  type EffectAcknowledgement,
  type EffectExecutionResult,
  type EffectPreview,
  type EffectRecord,
  type JsonValue,
  type RunProjection,
  type RunCommandTransaction,
  type ToolRegistrationContract,
} from "@pactmark/core";
import { z } from "zod";

export const RuntimeCompensationRequestSchema = z
  .object({
    schemaVersion: z.literal("1"),
    reason: z.string().trim().min(1).max(512),
    budget: WorkBudgetSchema,
  })
  .strict();
export type RuntimeCompensationRequest = z.infer<typeof RuntimeCompensationRequestSchema>;

export interface RuntimeEffectStore {
  getByEffectId(
    tenantId: string,
    runId: string,
    effectId: string,
  ): Promise<EffectRecord | undefined>;
  getByEffectKey(
    tenantId: string,
    runId: string,
    effectKey: string,
  ): Promise<EffectRecord | undefined>;
  /** Returns the validated plaintext from the protected acknowledged-result record. */
  getAcknowledgedResult(record: EffectRecord): Promise<JsonValue | undefined>;
}

export type RuntimeEffectDispatchContext = Readonly<{
  tenantId: string;
  runId: string;
  stepId: string;
  toolCallId: string;
  effectId: string;
  effectKey: string;
  normalizedTargetDigest: Digest;
  signal: AbortSignal;
}>;

type RuntimeEffectStrategyBase = Readonly<{
  registrationDigest: Digest;
  previewRegistrationDigest: Digest;
  preview(input: JsonValue, context: RuntimeEffectDispatchContext): Promise<EffectPreview>;
  validateOutput(result: unknown): JsonValue;
}>;

export type RuntimeExecutableEffectStrategy =
  | (RuntimeEffectStrategyBase &
      Readonly<{
        kind: "native";
        operationKey(input: JsonValue, binding: RuntimeEffectOperationBinding): string;
        dispatch(
          input: JsonValue,
          operationKey: string,
          context: RuntimeEffectDispatchContext,
        ): Promise<EffectExecutionResult>;
      }>)
  | (RuntimeEffectStrategyBase &
      Readonly<{
        kind: "reconcilable";
        operationKey(input: JsonValue, binding: RuntimeEffectOperationBinding): string;
        lookup(
          operationKey: string,
          context: RuntimeEffectDispatchContext,
        ): Promise<
          | Readonly<{ status: "applied"; execution: EffectExecutionResult }>
          | Readonly<{ status: "not_applied" }>
          | Readonly<{ status: "unknown" }>
        >;
        dispatch(
          input: JsonValue,
          operationKey: string,
          context: RuntimeEffectDispatchContext,
        ): Promise<EffectExecutionResult>;
      }>)
  | (RuntimeEffectStrategyBase &
      Readonly<{
        kind: "none";
        dispatch(
          input: JsonValue,
          context: RuntimeEffectDispatchContext,
        ): Promise<EffectExecutionResult>;
      }>);

export interface RuntimeEffectStrategyRegistry {
  resolve(toolRegistrationDigest: string): RuntimeExecutableEffectStrategy | undefined;
}

export type RuntimeEffectOperationBinding = Readonly<{
  effectKey: string;
  normalizedTargetDigest: Digest;
  toolRegistrationDigest: Digest;
}>;

export type RuntimeEffectAuthorizationRequest = Readonly<{
  workOrder: AcceptedWorkOrder;
  projection: RunProjection;
  registration: ToolRegistrationContract;
  stepId: string;
  toolCallId: string;
  effectId: string;
  effectKey: string;
  argumentsDigest: Digest;
  normalizedTargetDigest: Digest;
  authorizationKey: string;
  policyRegistrationDigest: Digest;
}>;

/** Resolves host-owned authority metadata; durable claims are made by the runtime UoW. */
export interface RuntimeEffectAuthorizationResolver {
  resolve(request: RuntimeEffectAuthorizationRequest): Promise<AuthorizationReservation>;
}

export type RuntimeEffectServices = Readonly<{
  store: RuntimeEffectStore;
  strategies: RuntimeEffectStrategyRegistry;
  authorization: RuntimeEffectAuthorizationResolver;
}>;

export type RuntimeCompensationBinding = Readonly<{
  definition: CompensationRunDefinition;
  deriveInput(
    original: Readonly<{
      result: JsonValue;
      acknowledgement: EffectAcknowledgement;
    }>,
  ): JsonValue;
  validateInput(input: unknown): JsonValue;
}>;

export type RuntimeCompensationIntent = Readonly<{
  originalTenantId: string;
  originalRunId: string;
  originalEffectId: string;
  originalEffectDigest: Digest;
  compensationRunId: string;
  compensationWorkOrderId: string;
  compensationRunDefinitionDigest: Digest;
  commandId: string;
}>;

export interface RuntimeCompensationServices {
  readonly transactionDomain: string;
  readonly registry: CompensationRunRegistry;
  resolve(originalToolRegistrationDigest: Digest): Promise<RuntimeCompensationBinding | undefined>;
  /** Must enforce one durable compensation intent per original effect in this transaction domain. */
  putIntentOnce(
    transaction: RunCommandTransaction,
    intent: RuntimeCompensationIntent,
  ): Promise<RuntimeCompensationIntent>;
}

export function createEffectKey(input: {
  readonly workOrderBindingDigest: Digest;
  readonly executionDefinitionDigest: Digest;
  readonly runId: string;
  readonly stepId: string;
  readonly toolCallId: string;
  readonly toolRegistrationDigest: Digest;
  readonly argumentsDigest: Digest;
  readonly normalizedTargetDigest: Digest;
}): string {
  return `pactmark-effect:${digestCanonicalJson({ schemaVersion: "1", ...input })}`;
}

export function effectProofDigest(
  acknowledgement: Omit<EffectAcknowledgement, "proofDigest">,
): Digest {
  return digestCanonicalJson({
    schemaVersion: acknowledgement.schemaVersion,
    proofKind: acknowledgement.proofKind,
    effectKey: acknowledgement.effectKey,
    ...(acknowledgement.operationKey === undefined
      ? {}
      : { operationKey: acknowledgement.operationKey }),
    toolRegistrationDigest: acknowledgement.toolRegistrationDigest,
    strategyRegistrationDigest: acknowledgement.strategyRegistrationDigest,
    normalizedTargetDigest: acknowledgement.normalizedTargetDigest,
    resultSchemaDigest: acknowledgement.resultSchemaDigest,
    resultDigest: acknowledgement.resultDigest,
    acknowledgedAt: acknowledgement.acknowledgedAt,
    safeReceiptMetadata: acknowledgement.safeReceiptMetadata ?? {},
  });
}

export function validateEffectExecution(input: {
  readonly execution: unknown;
  readonly strategy: RuntimeExecutableEffectStrategy;
  readonly registration: ToolRegistrationContract;
  readonly effectKey: string;
  readonly operationKey?: string;
  readonly normalizedTargetDigest: Digest;
}): Readonly<{ result: JsonValue; acknowledgement: EffectAcknowledgement }> {
  const execution = EffectExecutionResultSchema.parse(input.execution);
  const result = input.strategy.validateOutput(execution.result);
  const resultDigest = digestCanonicalJson(result);
  const acknowledgement = EffectAcknowledgementSchema.parse(execution.acknowledgement);
  const expected = {
    effectKey: input.effectKey,
    operationKey: input.operationKey,
    toolRegistrationDigest: input.registration.toolRegistrationDigest,
    strategyRegistrationDigest: input.registration.effectStrategyRegistrationDigest,
    normalizedTargetDigest: input.normalizedTargetDigest,
    resultSchemaDigest: input.registration.outputSchemaDigest,
    resultDigest,
  };
  const actual = {
    effectKey: acknowledgement.effectKey,
    operationKey: acknowledgement.operationKey,
    toolRegistrationDigest: acknowledgement.toolRegistrationDigest,
    strategyRegistrationDigest: acknowledgement.strategyRegistrationDigest,
    normalizedTargetDigest: acknowledgement.normalizedTargetDigest,
    resultSchemaDigest: acknowledgement.resultSchemaDigest,
    resultDigest: acknowledgement.resultDigest,
  };
  if (canonicalJsonStringify(actual) !== canonicalJsonStringify(expected)) {
    throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
      details: { reason: "effect_acknowledgement_binding_mismatch" },
    });
  }
  if (acknowledgement.proofDigest !== effectProofDigest(acknowledgement)) {
    throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
      details: { reason: "effect_acknowledgement_proof_mismatch" },
    });
  }
  return { result, acknowledgement };
}

export async function validateEffectPreview(input: {
  readonly strategy: RuntimeExecutableEffectStrategy;
  readonly registration: ToolRegistrationContract;
  readonly value: JsonValue;
  readonly context: RuntimeEffectDispatchContext;
  readonly normalizedTargetDigest: Digest;
}): Promise<EffectPreview> {
  const first = EffectPreviewSchema.parse(await input.strategy.preview(input.value, input.context));
  const second = EffectPreviewSchema.parse(
    await input.strategy.preview(input.value, input.context),
  );
  const material = (preview: EffectPreview): JsonValue => ({
    schemaVersion: preview.schemaVersion,
    normalizedTarget: preview.normalizedTarget,
    operationClass: preview.operationClass,
    contentDigest: preview.contentDigest,
    reversibility: preview.reversibility,
    materialConsequence: preview.materialConsequence,
    ...(preview.diffDigest === undefined ? {} : { diffDigest: preview.diffDigest }),
  });
  if (
    input.registration.previewStrategyRegistrationDigest === undefined ||
    input.strategy.previewRegistrationDigest !==
      input.registration.previewStrategyRegistrationDigest ||
    digestCanonicalJson(first.normalizedTarget) !== input.normalizedTargetDigest ||
    first.previewDigest !== digestCanonicalJson(material(first)) ||
    canonicalJsonStringify(first) !== canonicalJsonStringify(second)
  ) {
    throw new KafError("KAF_POLICY_DENIED", {
      details: { reason: "effect_preview_binding_or_determinism_failed" },
    });
  }
  return first;
}

export function validateAuthorizationReservation(input: {
  readonly reservation: unknown;
  readonly request: RuntimeEffectAuthorizationRequest;
  readonly now: string;
}): AuthorizationReservation {
  const reservation = AuthorizationReservationSchema.parse(input.reservation);
  const expected = {
    authorizationKey: input.request.authorizationKey,
    tenantId: input.request.workOrder.tenant.id,
    runId: input.request.projection.runId,
    stepId: input.request.stepId,
    toolCallId: input.request.toolCallId,
    effectKey: input.request.effectKey,
    workOrderBindingDigest: input.request.workOrder.workOrderBindingDigest,
    executionDefinition: input.request.workOrder.executionDefinition,
    executionDefinitionDigest: input.request.workOrder.executionDefinitionDigest,
    toolId: input.request.registration.id,
    toolVersion: input.request.registration.implementationVersion,
    toolRegistrationDigest: input.request.registration.toolRegistrationDigest,
    policyRegistrationDigest: input.request.policyRegistrationDigest,
    argumentsDigest: input.request.argumentsDigest,
    normalizedTargetDigest: input.request.normalizedTargetDigest,
    purposeCode: input.request.workOrder.purpose.code,
    purposeRegistryVersion: input.request.workOrder.purpose.registryVersion,
    state: "reserved",
  };
  const actual = {
    authorizationKey: reservation.authorizationKey,
    tenantId: reservation.tenantId,
    runId: reservation.runId,
    stepId: reservation.stepId,
    toolCallId: reservation.toolCallId,
    effectKey: reservation.effectKey,
    workOrderBindingDigest: reservation.workOrderBindingDigest,
    executionDefinition: reservation.executionDefinition,
    executionDefinitionDigest: reservation.executionDefinitionDigest,
    toolId: reservation.toolId,
    toolVersion: reservation.toolVersion,
    toolRegistrationDigest: reservation.toolRegistrationDigest,
    policyRegistrationDigest: reservation.policyRegistrationDigest,
    argumentsDigest: reservation.argumentsDigest,
    normalizedTargetDigest: reservation.normalizedTargetDigest,
    purposeCode: reservation.purposeCode,
    purposeRegistryVersion: reservation.purposeRegistryVersion,
    state: reservation.state,
  };
  if (
    canonicalJsonStringify(actual) !== canonicalJsonStringify(expected) ||
    Date.parse(reservation.createdAt) > Date.parse(input.now) ||
    Date.parse(reservation.expiresAt) <= Date.parse(input.now) ||
    reservation.secretRefIds.length > 0
  ) {
    throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
      details: {
        reason:
          reservation.secretRefIds.length > 0
            ? "effect_secret_ref_claim_port_unavailable"
            : "effect_authorization_reservation_mismatch",
      },
    });
  }
  return reservation;
}

export function assertEffectRecordBinding(
  recordInput: EffectRecord,
  expected: Readonly<{
    tenantId: string;
    runId: string;
    effectKey: string;
    toolRegistrationDigest: Digest;
    argumentsDigest: Digest;
    normalizedTargetDigest: Digest;
  }>,
): EffectRecord {
  const record = EffectRecordSchema.parse(recordInput);
  const actual = {
    tenantId: record.tenantId,
    runId: record.runId,
    effectKey: record.effectKey,
    toolRegistrationDigest: record.toolRegistrationDigest,
    argumentsDigest: record.argumentsDigest,
    normalizedTargetDigest: record.normalizedTargetDigest,
  };
  if (canonicalJsonStringify(actual) !== canonicalJsonStringify(expected)) {
    throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
      details: { reason: "effect_ledger_binding_mismatch" },
    });
  }
  return record;
}
