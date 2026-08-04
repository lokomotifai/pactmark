import {
  EffectRecordSchema,
  JsonValueSchema,
  KafError,
  ProtectedEffectResultRecordSchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  protectedEffectResultAad,
  type DataProtector,
  type EffectRecord,
  type JsonValue,
  type ProtectedEffectResultRecord,
  type RuntimeCapabilities,
  type StorageSecurityProfile,
} from "@pactmark/core";

import { POSTGRES_STORE_CAPABILITIES, PostgresStorageGuard } from "./config.js";
import type { PostgresDatabase } from "./database.js";
import { conflict, parseJsonColumn } from "./internal.js";

type EffectResultRow = {
  tenant_id: string;
  run_id: string;
  effect_id: string;
  effect_digest: string;
  result_digest: string;
  byte_size: string | number;
  work_order_id: string;
  work_order_binding_digest: string;
  execution_definition_digest: string;
  tool_id: string;
  tool_version: string;
  tool_registration_digest: string;
  strategy: string;
  strategy_registration_digest: string;
  result_schema_digest: string;
  purpose_code: string;
  purpose_registry_version: string;
  data_class: string;
  canonical_digest: string;
  record_json: unknown;
  protected_key_id: string;
  protected_ref: string;
};

const SELECT_COLUMNS = `tenant_id,run_id,effect_id,effect_digest,result_digest,byte_size,work_order_id,
  work_order_binding_digest,execution_definition_digest,tool_id,tool_version,
  tool_registration_digest,strategy,strategy_registration_digest,result_schema_digest,
  purpose_code,purpose_registry_version,data_class,canonical_digest,record_json,
  protected_key_id,protected_ref`;

/** Durable protected result reader/writer. Plaintext is never a SQL argument. */
export class PostgresAcknowledgedEffectResultStore {
  readonly capabilities: RuntimeCapabilities = POSTGRES_STORE_CAPABILITIES;
  readonly #guard: PostgresStorageGuard;
  readonly #protector: DataProtector | undefined;

  constructor(
    readonly database: PostgresDatabase,
    readonly securityProfile: StorageSecurityProfile,
    dataProtector?: DataProtector,
  ) {
    this.#guard = new PostgresStorageGuard(securityProfile);
    this.#protector = dataProtector;
  }

  async putImmutable(input: ProtectedEffectResultRecord): Promise<void> {
    const record = ProtectedEffectResultRecordSchema.parse(input);
    this.#guard.assertWriteAllowed(record.tenantId, record.purposeCode, record.dataClass);
    const existing = await this.#findIdentity(record);
    if (existing !== undefined) {
      assertSameStoredIdentity(existing, record);
      return;
    }
    const canonicalDigest = digestCanonicalJson(record);
    const inserted = await this.database.query(
      `INSERT INTO pactmark_acknowledged_effect_results
       (tenant_id,run_id,effect_id,effect_digest,result_digest,byte_size,work_order_id,
        work_order_binding_digest,execution_definition_digest,tool_id,tool_version,
        tool_registration_digest,strategy,strategy_registration_digest,result_schema_digest,
        purpose_code,purpose_registry_version,data_class,canonical_digest,record_json,
        protected_key_id,protected_ref,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
         $20::jsonb,$21,$22,$23::timestamptz)
       ON CONFLICT DO NOTHING`,
      [
        record.tenantId,
        record.runId,
        record.effectId,
        record.effectDigest,
        record.resultDigest,
        record.byteSize,
        record.workOrderId,
        record.workOrderBindingDigest,
        record.executionDefinitionDigest,
        record.toolId,
        record.toolVersion,
        record.toolRegistrationDigest,
        record.strategy,
        record.strategyRegistrationDigest,
        record.resultSchemaDigest,
        record.purposeCode,
        record.purposeRegistryVersion,
        record.dataClass,
        canonicalDigest,
        JSON.stringify(record),
        record.protectedValue.keyId,
        record.protectedValue.ciphertextRef,
        record.createdAt,
      ],
    );
    if (inserted.rowCount === 1) return;
    const raced = await this.#findIdentity(record);
    if (raced === undefined) conflict("acknowledged_effect_result_conflict");
    assertSameStoredIdentity(raced, record);
  }

  async getAcknowledgedResult(input: EffectRecord): Promise<JsonValue | undefined> {
    const effect = EffectRecordSchema.parse(input);
    this.#guard.assertTenantAllowed(effect.tenantId);
    if (effect.state !== "acknowledged") conflict("effect_result_requires_acknowledged_effect");
    const result = await this.database.query<EffectResultRow>(
      `SELECT ${SELECT_COLUMNS} FROM pactmark_acknowledged_effect_results
       WHERE tenant_id=$1 AND run_id=$2 AND effect_id=$3`,
      [effect.tenantId, effect.runId, effect.effectId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const record = parseAndVerifyRow(row);
    assertEffectResultRecordBinding(record, effect);
    if (this.#protector === undefined) rejectProtectedResult("data_protector_required");
    const plaintext = await this.#protector.unprotect(
      protectedEffectResultAad(record),
      record.protectedValue,
    );
    return parseAndVerifyResult(plaintext, record.resultDigest, record.byteSize);
  }

  async #findIdentity(record: ProtectedEffectResultRecord): Promise<EffectResultRow | undefined> {
    const result = await this.database.query<EffectResultRow>(
      `SELECT ${SELECT_COLUMNS} FROM pactmark_acknowledged_effect_results
       WHERE tenant_id=$1 AND ((run_id=$2 AND effect_id=$3) OR effect_digest=$4)`,
      [record.tenantId, record.runId, record.effectId, record.effectDigest],
    );
    if (result.rows.length > 1) conflict("acknowledged_effect_result_identity_split");
    return result.rows[0];
  }
}

export function assertEffectResultRecordBinding(
  input: ProtectedEffectResultRecord,
  effectInput: EffectRecord,
): void {
  const record = ProtectedEffectResultRecordSchema.parse(input);
  const effect = EffectRecordSchema.parse(effectInput);
  if (effect.state !== "acknowledged") conflict("effect_result_requires_acknowledged_effect");
  const expected = {
    tenantId: effect.tenantId,
    runId: effect.runId,
    effectId: effect.effectId,
    effectDigest: effect.effectDigest,
    resultDigest: effect.resultDigest,
    workOrderBindingDigest: effect.workOrderBindingDigest,
    executionDefinition: effect.executionDefinition,
    executionDefinitionDigest: effect.executionDefinitionDigest,
    toolId: effect.toolId,
    toolVersion: effect.toolVersion,
    toolRegistrationDigest: effect.toolRegistrationDigest,
    strategy: effect.strategy,
    strategyRegistrationDigest: effect.strategyRegistrationDigest,
    resultSchemaDigest: effect.acknowledgement.resultSchemaDigest,
    createdAt: effect.updatedAt,
  };
  const actual = {
    tenantId: record.tenantId,
    runId: record.runId,
    effectId: record.effectId,
    effectDigest: record.effectDigest,
    resultDigest: record.resultDigest,
    workOrderBindingDigest: record.workOrderBindingDigest,
    executionDefinition: record.executionDefinition,
    executionDefinitionDigest: record.executionDefinitionDigest,
    toolId: record.toolId,
    toolVersion: record.toolVersion,
    toolRegistrationDigest: record.toolRegistrationDigest,
    strategy: record.strategy,
    strategyRegistrationDigest: record.strategyRegistrationDigest,
    resultSchemaDigest: record.resultSchemaDigest,
    createdAt: record.createdAt,
  };
  if (canonicalJsonStringify(actual) !== canonicalJsonStringify(expected)) {
    conflict("acknowledged_effect_result_binding_changed");
  }
}

function assertSameStoredIdentity(
  row: EffectResultRow,
  candidate: ProtectedEffectResultRecord,
): void {
  const stored = parseAndVerifyRow(row);
  if (
    stored.tenantId !== candidate.tenantId ||
    stored.runId !== candidate.runId ||
    stored.effectId !== candidate.effectId ||
    protectedEffectResultIdentityDigest(stored) !== protectedEffectResultIdentityDigest(candidate)
  ) {
    conflict("acknowledged_effect_result_changed");
  }
}

function parseAndVerifyRow(row: EffectResultRow): ProtectedEffectResultRecord {
  const record = ProtectedEffectResultRecordSchema.parse(parseJsonColumn(row.record_json));
  const columns = {
    tenantId: row.tenant_id,
    runId: row.run_id,
    effectId: row.effect_id,
    effectDigest: row.effect_digest,
    resultDigest: row.result_digest,
    byteSize: Number(row.byte_size),
    workOrderId: row.work_order_id,
    workOrderBindingDigest: row.work_order_binding_digest,
    executionDefinitionDigest: row.execution_definition_digest,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    toolRegistrationDigest: row.tool_registration_digest,
    strategy: row.strategy,
    strategyRegistrationDigest: row.strategy_registration_digest,
    resultSchemaDigest: row.result_schema_digest,
    purposeCode: row.purpose_code,
    purposeRegistryVersion: row.purpose_registry_version,
    dataClass: row.data_class,
    protectedKeyId: row.protected_key_id,
    protectedRef: row.protected_ref,
  };
  const value = {
    tenantId: record.tenantId,
    runId: record.runId,
    effectId: record.effectId,
    effectDigest: record.effectDigest,
    resultDigest: record.resultDigest,
    byteSize: record.byteSize,
    workOrderId: record.workOrderId,
    workOrderBindingDigest: record.workOrderBindingDigest,
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
    protectedKeyId: record.protectedValue.keyId,
    protectedRef: record.protectedValue.ciphertextRef,
  };
  if (
    canonicalJsonStringify(columns) !== canonicalJsonStringify(value) ||
    digestCanonicalJson(record) !== row.canonical_digest
  ) {
    conflict("acknowledged_effect_result_row_changed");
  }
  return record;
}

function protectedEffectResultIdentityDigest(record: ProtectedEffectResultRecord): string {
  const { protectedValue: _protectedValue, ...identity } = record;
  void _protectedValue;
  return digestCanonicalJson(identity);
}

function parseAndVerifyResult(
  plaintext: Uint8Array,
  expectedDigest: string,
  expectedByteSize: number,
): JsonValue {
  if (plaintext.byteLength !== expectedByteSize) {
    conflict("acknowledged_effect_result_byte_size_changed");
  }
  const serialized = new TextDecoder().decode(plaintext);
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch (internalCause) {
    throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
      details: { reason: "protected_effect_result_invalid_json" },
      internalCause,
    });
  }
  const result = JsonValueSchema.parse(decoded);
  if (
    canonicalJsonStringify(result) !== serialized ||
    digestCanonicalJson(result) !== expectedDigest
  ) {
    conflict("acknowledged_effect_result_payload_changed");
  }
  return structuredClone(result);
}

function rejectProtectedResult(reason: string): never {
  throw new KafError("KAF_STORAGE_SECURITY_PROFILE", { details: { reason } });
}
