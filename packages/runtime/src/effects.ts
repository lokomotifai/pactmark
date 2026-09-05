import {
  AuthorizationReservationSchema,
  EffectAcknowledgementSchema,
  EffectExecutionResultSchema,
  EffectPreviewSchema,
  EffectRecordSchema,
  RuntimeCompensationRequestSchema,
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

export { RuntimeCompensationRequestSchema };
export type { RuntimeCompensationRequest } from "@pactmark/core";

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
  purposeCode: string;
  dataClass: AcceptedWorkOrder["dataClass"];
  signal: AbortSignal;
}>;

type RuntimeEffectStrategyBase = Readonly<{
  registrationDigest: Digest;
  previewRegistrationDigest: Digest;
  preview(input: JsonValue, context: RuntimeEffectDispatchContext): Promise<EffectPreview>;
  validateOutput(result: unknown): JsonValue;
}>;

const RuntimeEffectLookupResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), execution: EffectExecutionResultSchema }).strict(),
  z.object({ status: z.literal("not_applied") }).strict(),
  z.object({ status: z.literal("unknown") }).strict(),
]);
export type RuntimeEffectLookupResult = z.infer<typeof RuntimeEffectLookupResultSchema>;

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
        ): Promise<RuntimeEffectLookupResult>;
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

export function validateEffectLookupResult(input: unknown): RuntimeEffectLookupResult {
  const result = RuntimeEffectLookupResultSchema.safeParse(input);
  if (!result.success) {
    throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
      details: { reason: "effect_lookup_result_invalid" },
      internalCause: result.error,
    });
  }
  return result.data;
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
  /** Exact runtime-recorded approval authorizing this effect, when required. */
  approvalId?: string;
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
  // Strategies of kind "none" carry no operation key; the canonical
  // comparison must omit the absent key on both sides instead of
  // serializing undefined, which the canonical encoder rejects.
  const expected = {
    effectKey: input.effectKey,
    ...(input.operationKey === undefined ? {} : { operationKey: input.operationKey }),
    toolRegistrationDigest: input.registration.toolRegistrationDigest,
    strategyRegistrationDigest: input.registration.effectStrategyRegistrationDigest,
    normalizedTargetDigest: input.normalizedTargetDigest,
    resultSchemaDigest: input.registration.outputSchemaDigest,
    resultDigest,
  };
  const actual = {
    effectKey: acknowledgement.effectKey,
    ...(acknowledgement.operationKey === undefined
      ? {}
      : { operationKey: acknowledgement.operationKey }),
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
    ...(preview.approvalDisplay === undefined
      ? {}
      : {
          approvalDisplay: {
            title: preview.approvalDisplay.title,
            summary: preview.approvalDisplay.summary,
            materialConsequence: preview.approvalDisplay.materialConsequence,
            reversibility: preview.approvalDisplay.reversibility,
            ...(preview.approvalDisplay.fields === undefined
              ? {}
              : {
                  fields: preview.approvalDisplay.fields.map(({ label, value }) => ({
                    label,
                    value,
                  })),
                }),
          },
        }),
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
    ...(input.request.approvalId === undefined ? {} : { approvalId: input.request.approvalId }),
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
    ...(reservation.approvalId === undefined ? {} : { approvalId: reservation.approvalId }),
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
    reservation.consumedAt !== undefined ||
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

export function markAuthorizationReservationConsumed(input: {
  readonly reservation: AuthorizationReservation;
  readonly consumedAt: string;
}): AuthorizationReservation {
  const reservation = AuthorizationReservationSchema.parse(input.reservation);
  if (
    reservation.state !== "reserved" ||
    reservation.consumedAt !== undefined ||
    Date.parse(input.consumedAt) < Date.parse(reservation.createdAt) ||
    Date.parse(input.consumedAt) >= Date.parse(reservation.expiresAt)
  ) {
    throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
      details: { reason: "effect_authorization_reservation_not_consumable" },
    });
  }
  return AuthorizationReservationSchema.parse({
    ...reservation,
    state: "consumed",
    consumedAt: input.consumedAt,
  });
}

export function assertEffectRecordBinding(
  recordInput: EffectRecord,
  expected: Readonly<{
    tenantId: string;
    runId: string;
    effectKey: string;
    toolRegistrationDigest: Digest;
    strategy: EffectRecord["strategy"];
    strategyRegistrationDigest: Digest;
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
    strategy: record.strategy,
    strategyRegistrationDigest: record.strategyRegistrationDigest,
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
