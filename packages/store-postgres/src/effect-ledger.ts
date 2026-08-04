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
  type StorageSecurityProfile,
} from "@pactmark/core";

import { PostgresStorageGuard } from "./config.js";
import type { PostgresClient, PostgresDatabase } from "./database.js";
import { conflict, parseJsonColumn } from "./internal.js";
import type { PostgresAcknowledgedEffectResultStore } from "./acknowledged-effect-results.js";

type AuthorizationRow = { reservation_json: unknown };
type EffectRow = { effect_id: string; run_id: string; effect_json: unknown };

export class PostgresEffectLedger {
  readonly #guard: PostgresStorageGuard;

  constructor(
    readonly database: PostgresDatabase,
    securityProfile: StorageSecurityProfile,
    readonly acknowledgedEffectResultStore?: PostgresAcknowledgedEffectResultStore,
  ) {
    this.#guard = new PostgresStorageGuard(securityProfile);
  }

  getAcknowledgedResult(record: EffectRecord): Promise<JsonValue | undefined> {
    return (
      this.acknowledgedEffectResultStore?.getAcknowledgedResult(record) ??
      Promise.resolve(undefined)
    );
  }

  async getAuthorizationReservation(
    tenantId: string,
    authorizationReservationId: string,
  ): Promise<AuthorizationReservation | undefined> {
    this.#guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<AuthorizationRow>(
      `SELECT reservation_json FROM pactmark_authorization_reservations
       WHERE tenant_id=$1 AND reservation_id=$2`,
      [tenantId, authorizationReservationId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : AuthorizationReservationSchema.parse(parseJsonColumn(row.reservation_json));
  }

  async getByEffectId(
    tenantId: string,
    runId: string,
    effectId: string,
  ): Promise<EffectRecord | undefined> {
    return this.#getEffect(
      "tenant_id=$1 AND run_id=$2 AND effect_id=$3",
      tenantId,
      runId,
      effectId,
    );
  }

  async getByEffectKey(
    tenantId: string,
    runId: string,
    effectKey: string,
  ): Promise<EffectRecord | undefined> {
    return this.#getEffect(
      "tenant_id=$1 AND run_id=$2 AND effect_key=$3",
      tenantId,
      runId,
      effectKey,
    );
  }

  async #getEffect(
    predicate: string,
    tenantId: string,
    runId: string,
    key: string,
  ): Promise<EffectRecord | undefined> {
    this.#guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<EffectRow>(
      `SELECT effect_id,run_id,effect_json FROM pactmark_effects WHERE ${predicate}`,
      [tenantId, runId, key],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : EffectRecordSchema.parse(parseJsonColumn(row.effect_json));
  }
}

export async function putAuthorizationReservation(
  client: PostgresClient,
  tenantId: string,
  input: AuthorizationReservation,
): Promise<void> {
  const reservation = AuthorizationReservationSchema.parse(input);
  if (reservation.tenantId !== tenantId) conflict("cross_tenant_authorization_reservation");
  const prior = await client.query<AuthorizationRow>(
    `SELECT reservation_json FROM pactmark_authorization_reservations
     WHERE tenant_id=$1 AND (reservation_id=$2 OR authorization_key=$3) FOR UPDATE`,
    [tenantId, reservation.authorizationReservationId, reservation.authorizationKey],
  );
  if (prior.rows.length > 1) conflict("authorization_reservation_key_split");
  const existing = prior.rows[0];
  if (existing !== undefined) {
    const stored = AuthorizationReservationSchema.parse(parseJsonColumn(existing.reservation_json));
    if (canonicalJsonStringify(stored) === canonicalJsonStringify(reservation)) return;
    conflict("authorization_reservation_changed");
  }
  await client.query(
    `INSERT INTO pactmark_authorization_reservations
     (tenant_id,reservation_id,authorization_key,binding_digest,state,run_id,effect_key,
      expires_at,reservation_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::jsonb)`,
    [
      tenantId,
      reservation.authorizationReservationId,
      reservation.authorizationKey,
      digestCanonicalJson(reservation),
      reservation.state,
      reservation.runId,
      reservation.effectKey ?? null,
      reservation.expiresAt,
      JSON.stringify(reservation),
    ],
  );
}

export async function putEffectRecord(
  client: PostgresClient,
  tenantId: string,
  input: EffectRecord,
): Promise<void> {
  const record = EffectRecordSchema.parse(input);
  if (record.tenantId !== tenantId) conflict("cross_tenant_effect_record");
  assertEffectDigest(record);
  const authorizationResult = await client.query<AuthorizationRow>(
    `SELECT reservation_json FROM pactmark_authorization_reservations
     WHERE tenant_id=$1 AND reservation_id=$2 FOR UPDATE`,
    [tenantId, record.authorizationReservationId],
  );
  const authorizationRow = authorizationResult.rows[0];
  if (authorizationRow === undefined) conflict("effect_authorization_reservation_missing");
  const reservation = AuthorizationReservationSchema.parse(
    parseJsonColumn(authorizationRow.reservation_json),
  );
  assertEffectAuthorizationBinding(record, reservation);

  const prior = await client.query<EffectRow>(
    `SELECT effect_id,run_id,effect_json FROM pactmark_effects
     WHERE tenant_id=$1 AND
       ((run_id=$2 AND (effect_id=$3 OR effect_key=$4)) OR
        ($5::text IS NOT NULL AND operation_key=$5)) FOR UPDATE`,
    [tenantId, record.runId, record.effectId, record.effectKey, record.operationKey ?? null],
  );
  if (prior.rows.length > 1) conflict("effect_key_split");
  const existingRow = prior.rows[0];
  if (existingRow !== undefined) {
    if (existingRow.effect_id !== record.effectId || existingRow.run_id !== record.runId) {
      conflict("effect_key_reused");
    }
    const existing = EffectRecordSchema.parse(parseJsonColumn(existingRow.effect_json));
    if (canonicalJsonStringify(existing) === canonicalJsonStringify(record)) return;
    if (
      existing.effectDigest !== record.effectDigest ||
      !isEffectTransitionAllowed(existing.state, record.state, record.strategy) ||
      Date.parse(record.updatedAt) < Date.parse(existing.updatedAt)
    ) {
      conflict("effect_record_changed");
    }
    await client.query(
      `UPDATE pactmark_effects SET state=$1,effect_json=$2::jsonb,updated_at=$3::timestamptz
       WHERE tenant_id=$4 AND run_id=$5 AND effect_id=$6`,
      [
        record.state,
        JSON.stringify(record),
        record.updatedAt,
        tenantId,
        record.runId,
        record.effectId,
      ],
    );
    return;
  }
  await client.query(
    `INSERT INTO pactmark_effects
     (tenant_id,run_id,effect_id,operation_key,binding_digest,state,effect_json,effect_key,
      effect_digest,authorization_reservation_id,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::timestamptz)`,
    [
      tenantId,
      record.runId,
      record.effectId,
      record.operationKey ?? null,
      record.effectDigest,
      record.state,
      JSON.stringify(record),
      record.effectKey,
      record.effectDigest,
      record.authorizationReservationId,
      record.updatedAt,
    ],
  );
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
    reservation.state !== "reserved" ||
    canonicalJsonStringify(effectBinding) !== canonicalJsonStringify(authorizationBinding)
  ) {
    throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
      details: { reason: "effect_authorization_binding_mismatch" },
    });
  }
}
