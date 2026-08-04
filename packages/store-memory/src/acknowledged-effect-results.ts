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

import { MEMORY_STORE_CAPABILITIES, MemoryStorageGuard } from "./config.js";
import { cloneJson, conflict, recordKey, sameJson } from "./internal.js";

type StoredEffectResult = Readonly<{
  identityDigest: string;
  canonicalDigest: string;
  record: ProtectedEffectResultRecord;
}>;

export type MemoryAcknowledgedEffectResultSnapshot = Readonly<{
  records: Map<string, StoredEffectResult>;
  effectDigests: Map<string, string>;
  protectedRefs: Map<string, string>;
}>;

/**
 * Process-local protected result storage. The plaintext is never retained by
 * this adapter; callers must protect canonical result bytes before opening the
 * command/transition transaction.
 */
export class MemoryAcknowledgedEffectResultStore {
  readonly capabilities: RuntimeCapabilities = MEMORY_STORE_CAPABILITIES;
  readonly #guard: MemoryStorageGuard;
  readonly #protector: DataProtector | undefined;
  #records = new Map<string, StoredEffectResult>();
  #effectDigests = new Map<string, string>();
  #protectedRefs = new Map<string, string>();

  constructor(
    readonly securityProfile: StorageSecurityProfile,
    dataProtector?: DataProtector,
  ) {
    this.#guard = new MemoryStorageGuard(securityProfile);
    this.#protector = dataProtector;
  }

  async putImmutable(input: ProtectedEffectResultRecord): Promise<void> {
    await Promise.resolve();
    const record = ProtectedEffectResultRecordSchema.parse(input);
    this.#guard.assertWriteAllowed(record.tenantId, record.purposeCode, record.dataClass);
    const route = recordKey(record.tenantId, record.runId, record.effectId);
    const identityDigest = protectedEffectResultIdentityDigest(record);
    const canonicalDigest = digestCanonicalJson(record);
    const existing = this.#records.get(route);
    if (existing !== undefined) {
      if (existing.identityDigest === identityDigest) return;
      conflict("acknowledged_effect_result_changed");
    }
    const digestRoute = recordKey(record.tenantId, record.effectDigest);
    const priorDigestRoute = this.#effectDigests.get(digestRoute);
    if (priorDigestRoute !== undefined && priorDigestRoute !== route) {
      conflict("acknowledged_effect_result_digest_reused");
    }
    const protectedRoute = recordKey(
      record.tenantId,
      record.protectedValue.keyId,
      record.protectedValue.ciphertextRef,
    );
    const priorProtectedRoute = this.#protectedRefs.get(protectedRoute);
    if (priorProtectedRoute !== undefined && priorProtectedRoute !== route) {
      conflict("acknowledged_effect_result_protected_ref_reused");
    }
    this.#records.set(route, {
      identityDigest,
      canonicalDigest,
      record: cloneJson(record),
    });
    this.#effectDigests.set(digestRoute, route);
    this.#protectedRefs.set(protectedRoute, route);
  }

  async getAcknowledgedResult(input: EffectRecord): Promise<JsonValue | undefined> {
    await Promise.resolve();
    const effect = EffectRecordSchema.parse(input);
    this.#guard.assertTenantAllowed(effect.tenantId);
    if (effect.state !== "acknowledged") conflict("effect_result_requires_acknowledged_effect");
    const stored = this.#records.get(recordKey(effect.tenantId, effect.runId, effect.effectId));
    if (stored === undefined) return undefined;
    const record = ProtectedEffectResultRecordSchema.parse(cloneJson(stored.record));
    assertEffectResultRecordBinding(record, effect);
    if (digestCanonicalJson(record) !== stored.canonicalDigest) {
      conflict("acknowledged_effect_result_record_changed");
    }
    if (this.#protector === undefined) rejectProtectedResult("data_protector_required");
    const plaintext = await this.#protector.unprotect(
      protectedEffectResultAad(record),
      record.protectedValue,
    );
    return parseAndVerifyResult(plaintext, record.resultDigest, record.byteSize);
  }

  transactionSnapshot(): MemoryAcknowledgedEffectResultSnapshot {
    return {
      records: structuredClone(this.#records),
      effectDigests: structuredClone(this.#effectDigests),
      protectedRefs: structuredClone(this.#protectedRefs),
    };
  }

  transactionRestore(snapshot: MemoryAcknowledgedEffectResultSnapshot): void {
    this.#records = snapshot.records;
    this.#effectDigests = snapshot.effectDigests;
    this.#protectedRefs = snapshot.protectedRefs;
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
  if (!sameJson(actual, expected)) conflict("acknowledged_effect_result_binding_changed");
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
  return cloneJson(result);
}

function rejectProtectedResult(reason: string): never {
  throw new KafError("KAF_STORAGE_SECURITY_PROFILE", { details: { reason } });
}
