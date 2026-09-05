import {
  AuthorizationReservationSchema,
  EffectRecordSchema,
  KafError,
  canonicalJsonStringify,
  digestCanonicalJson,
  isEffectTransitionAllowed,
  type AuthorizationReservation,
  type EffectRecord,
  type JsonValue,
} from "@pactmark/core";

import type { MemoryAcknowledgedEffectResultStore } from "./acknowledged-effect-results.js";
import { cloneJson, conflict, recordKey, sameJson } from "./internal.js";

type LedgerSnapshot = Readonly<{
  reservations: Map<string, AuthorizationReservation>;
  reservationKeys: Map<string, string>;
  effects: Map<string, EffectRecord>;
  effectKeys: Map<string, string>;
  operationKeys: Map<string, string>;
}>;

export class MemoryEffectLedger {
  #reservations = new Map<string, AuthorizationReservation>();
  #reservationKeys = new Map<string, string>();
  #effects = new Map<string, EffectRecord>();
  #effectKeys = new Map<string, string>();
  #operationKeys = new Map<string, string>();

  constructor(readonly acknowledgedEffectResultStore?: MemoryAcknowledgedEffectResultStore) {}

  async putAuthorizationReservation(input: AuthorizationReservation): Promise<void> {
    await Promise.resolve();
    const reservation = AuthorizationReservationSchema.parse(input);
    const idKey = recordKey(reservation.tenantId, reservation.authorizationReservationId);
    const authorizationKey = recordKey(reservation.tenantId, reservation.authorizationKey);
    const existing = this.#reservations.get(idKey);
    if (existing !== undefined) {
      if (sameJson(existing, reservation)) return;
      conflict("authorization_reservation_changed");
    }
    const priorId = this.#reservationKeys.get(authorizationKey);
    if (priorId !== undefined && priorId !== idKey) conflict("authorization_key_reused");
    this.#reservations.set(idKey, cloneJson(reservation));
    this.#reservationKeys.set(authorizationKey, idKey);
  }

  async getAuthorizationReservation(
    tenantId: string,
    authorizationReservationId: string,
  ): Promise<AuthorizationReservation | undefined> {
    await Promise.resolve();
    const value = this.#reservations.get(recordKey(tenantId, authorizationReservationId));
    return value === undefined ? undefined : cloneJson(value);
  }

  async putEffectRecord(input: EffectRecord): Promise<void> {
    await Promise.resolve();
    const record = EffectRecordSchema.parse(input);
    assertEffectDigest(record);
    const idKey = recordKey(record.tenantId, record.runId, record.effectId);
    const effectKey = recordKey(record.tenantId, record.runId, record.effectKey);
    const operationKey =
      record.operationKey === undefined
        ? undefined
        : recordKey(record.tenantId, record.operationKey);
    const reservation = this.#reservations.get(
      recordKey(record.tenantId, record.authorizationReservationId),
    );
    if (reservation === undefined) conflict("effect_authorization_reservation_missing");
    assertEffectAuthorizationBinding(record, reservation);

    const priorEffectId = this.#effectKeys.get(effectKey);
    if (priorEffectId !== undefined && priorEffectId !== idKey) conflict("effect_key_reused");
    if (operationKey !== undefined) {
      const priorOperationId = this.#operationKeys.get(operationKey);
      if (priorOperationId !== undefined && priorOperationId !== idKey) {
        conflict("effect_operation_key_reused");
      }
    }
    const existing = this.#effects.get(idKey);
    if (existing !== undefined) {
      if (sameJson(existing, record)) return;
      if (
        existing.effectDigest !== record.effectDigest ||
        !isEffectTransitionAllowed(existing.state, record.state, record.strategy) ||
        Date.parse(record.updatedAt) < Date.parse(existing.updatedAt)
      ) {
        conflict("effect_record_changed");
      }
    }
    this.#effects.set(idKey, cloneJson(record));
    this.#effectKeys.set(effectKey, idKey);
    if (operationKey !== undefined) this.#operationKeys.set(operationKey, idKey);
  }

  async getByEffectId(
    tenantId: string,
    runId: string,
    effectId: string,
  ): Promise<EffectRecord | undefined> {
    await Promise.resolve();
    const value = this.#effects.get(recordKey(tenantId, runId, effectId));
    return value === undefined ? undefined : cloneJson(value);
  }

  async getByEffectKey(
    tenantId: string,
    runId: string,
    effectKey: string,
  ): Promise<EffectRecord | undefined> {
    await Promise.resolve();
    const id = this.#effectKeys.get(recordKey(tenantId, runId, effectKey));
    const value = id === undefined ? undefined : this.#effects.get(id);
    return value === undefined ? undefined : cloneJson(value);
  }

  getAcknowledgedResult(record: EffectRecord): Promise<JsonValue | undefined> {
    return (
      this.acknowledgedEffectResultStore?.getAcknowledgedResult(record) ??
      Promise.resolve(undefined)
    );
  }

  snapshot(): LedgerSnapshot {
    return {
      reservations: structuredClone(this.#reservations),
      reservationKeys: structuredClone(this.#reservationKeys),
      effects: structuredClone(this.#effects),
      effectKeys: structuredClone(this.#effectKeys),
      operationKeys: structuredClone(this.#operationKeys),
    };
  }

  restore(snapshot: LedgerSnapshot): void {
    this.#reservations = snapshot.reservations;
    this.#reservationKeys = snapshot.reservationKeys;
    this.#effects = snapshot.effects;
    this.#effectKeys = snapshot.effectKeys;
    this.#operationKeys = snapshot.operationKeys;
  }
}

function effectIdentity(record: EffectRecord) {
  return {
    schemaVersion: record.schemaVersion,
    effectId: record.effectId,
    tenantId: record.tenantId,
    runId: record.runId,
    stepId: record.stepId,
    toolCallId: record.toolCallId,
    effectKey: record.effectKey,
    ...(record.operationKey === undefined ? {} : { operationKey: record.operationKey }),
    executionDefinition: record.executionDefinition,
    executionDefinitionDigest: record.executionDefinitionDigest,
    workOrderBindingDigest: record.workOrderBindingDigest,
    toolId: record.toolId,
    toolVersion: record.toolVersion,
    toolRegistrationDigest: record.toolRegistrationDigest,
    strategy: record.strategy,
    strategyRegistrationDigest: record.strategyRegistrationDigest,
    authorizationReservationId: record.authorizationReservationId,
    argumentsDigest: record.argumentsDigest,
    normalizedTargetDigest: record.normalizedTargetDigest,
    createdAt: record.createdAt,
  };
}

function assertEffectDigest(record: EffectRecord): void {
  if (record.effectDigest !== digestCanonicalJson(effectIdentity(record))) {
    throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
      details: { reason: "effect_digest_mismatch" },
    });
  }
}

function assertEffectAuthorizationBinding(
  record: EffectRecord,
  reservation: AuthorizationReservation,
): void {
  // v0.2 persisted prepared effects while their linked reservation was still
  // `reserved`. New runtime writes consume the reservation atomically with the
  // prepared effect, but accepting the legacy shape keeps those effects resumable.
  const hasValidLifecycleState =
    (reservation.state === "reserved" && reservation.consumedAt === undefined) ||
    (reservation.state === "consumed" && reservation.consumedAt !== undefined);
  const effectBinding = {
    tenantId: record.tenantId,
    runId: record.runId,
    stepId: record.stepId,
    toolCallId: record.toolCallId,
    effectKey: record.effectKey,
    executionDefinition: record.executionDefinition,
    executionDefinitionDigest: record.executionDefinitionDigest,
    workOrderBindingDigest: record.workOrderBindingDigest,
    toolId: record.toolId,
    toolVersion: record.toolVersion,
    toolRegistrationDigest: record.toolRegistrationDigest,
    argumentsDigest: record.argumentsDigest,
    normalizedTargetDigest: record.normalizedTargetDigest,
  };
  const authorizationBinding = {
    tenantId: reservation.tenantId,
    runId: reservation.runId,
    stepId: reservation.stepId,
    toolCallId: reservation.toolCallId,
    effectKey: reservation.effectKey,
    executionDefinition: reservation.executionDefinition,
    executionDefinitionDigest: reservation.executionDefinitionDigest,
    workOrderBindingDigest: reservation.workOrderBindingDigest,
    toolId: reservation.toolId,
    toolVersion: reservation.toolVersion,
    toolRegistrationDigest: reservation.toolRegistrationDigest,
    argumentsDigest: reservation.argumentsDigest,
    normalizedTargetDigest: reservation.normalizedTargetDigest,
  };
  if (
    reservation.authorizationReservationId !== record.authorizationReservationId ||
    !hasValidLifecycleState ||
    canonicalJsonStringify(effectBinding) !== canonicalJsonStringify(authorizationBinding)
  ) {
    throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
      details: { reason: "effect_authorization_binding_mismatch" },
    });
  }
}
