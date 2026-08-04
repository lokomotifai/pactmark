import {
  EvidenceRecordSchema,
  PatternRecordSchema,
  VerificationRecordSchema,
  digestCanonicalJson,
  type Digest,
  type EvidenceRecord,
  type EvidenceRecordStore,
  type PatternRecord,
  type PatternRecordStore,
  type RuntimeCapabilities,
  type StorageSecurityProfile,
  type VerificationRecord,
  type VerificationRecordStore,
} from "@pactmark/core";

import { MEMORY_STORE_CAPABILITIES, MemoryStorageGuard } from "./config.js";
import { cloneJson, conflict, recordKey, sameJson } from "./internal.js";

export class MemoryEvidenceRecordStore implements EvidenceRecordStore {
  readonly capabilities: RuntimeCapabilities = MEMORY_STORE_CAPABILITIES;
  readonly #guard: MemoryStorageGuard;
  readonly #records = new Map<string, EvidenceRecord>();
  readonly #digests = new Map<string, string>();

  constructor(securityProfile: StorageSecurityProfile) {
    this.#guard = new MemoryStorageGuard(securityProfile);
  }

  async putImmutable(input: EvidenceRecord): Promise<void> {
    await Promise.resolve();
    const record = EvidenceRecordSchema.parse(input);
    this.#guard.assertWriteAllowed(
      record.tenantId,
      record.permission.purposeCode,
      record.permission.dataClass,
    );
    assertEvidenceDigest(record);
    const key = recordKey(record.tenantId, record.evidenceRecordId);
    putImmutable(this.#records, this.#digests, key, record.tenantId, record.evidenceDigest, record);
  }

  async get(tenantId: string, evidenceRecordId: string): Promise<EvidenceRecord | undefined> {
    await Promise.resolve();
    this.#guard.assertTenantAllowed(tenantId);
    return cloneOptional(this.#records.get(recordKey(tenantId, evidenceRecordId)));
  }

  async getByDigest(tenantId: string, evidenceDigest: Digest): Promise<EvidenceRecord | undefined> {
    await Promise.resolve();
    this.#guard.assertTenantAllowed(tenantId);
    const key = this.#digests.get(recordKey(tenantId, evidenceDigest));
    return key === undefined ? undefined : cloneOptional(this.#records.get(key));
  }
}

export class MemoryVerificationRecordStore implements VerificationRecordStore {
  readonly capabilities: RuntimeCapabilities = MEMORY_STORE_CAPABILITIES;
  readonly #guard: MemoryStorageGuard;
  readonly #records = new Map<string, VerificationRecord>();
  readonly #digests = new Map<string, string>();

  constructor(securityProfile: StorageSecurityProfile) {
    this.#guard = new MemoryStorageGuard(securityProfile);
  }

  async putImmutable(input: VerificationRecord): Promise<void> {
    await Promise.resolve();
    const record = VerificationRecordSchema.parse(input);
    this.#guard.assertWriteAllowed(record.tenantId, record.purposeCode, record.dataClass);
    assertVerificationDigest(record);
    const key = recordKey(record.tenantId, record.runId, record.verification.verificationId);
    putImmutable(
      this.#records,
      this.#digests,
      key,
      record.tenantId,
      record.verification.verificationDigest,
      record,
    );
  }

  async get(
    tenantId: string,
    runId: string,
    verificationId: string,
  ): Promise<VerificationRecord | undefined> {
    await Promise.resolve();
    this.#guard.assertTenantAllowed(tenantId);
    return cloneOptional(this.#records.get(recordKey(tenantId, runId, verificationId)));
  }

  async getByDigest(
    tenantId: string,
    verificationDigest: Digest,
  ): Promise<VerificationRecord | undefined> {
    await Promise.resolve();
    this.#guard.assertTenantAllowed(tenantId);
    const key = this.#digests.get(recordKey(tenantId, verificationDigest));
    return key === undefined ? undefined : cloneOptional(this.#records.get(key));
  }
}

export class MemoryPatternRecordStore implements PatternRecordStore {
  readonly capabilities: RuntimeCapabilities = MEMORY_STORE_CAPABILITIES;
  readonly #guard: MemoryStorageGuard;
  readonly #records = new Map<string, PatternRecord>();
  readonly #digests = new Map<string, string>();

  constructor(securityProfile: StorageSecurityProfile) {
    this.#guard = new MemoryStorageGuard(securityProfile);
  }

  async putImmutable(input: PatternRecord): Promise<void> {
    await Promise.resolve();
    const record = PatternRecordSchema.parse(input);
    this.#guard.assertWriteAllowed(record.tenantId, record.purposeCode, record.dataClass);
    assertPatternDigest(record);
    const key = recordKey(record.tenantId, record.pattern.patternId, record.pattern.version);
    putImmutable(
      this.#records,
      this.#digests,
      key,
      record.tenantId,
      record.pattern.patternDigest,
      record,
    );
  }

  async get(
    tenantId: string,
    patternId: string,
    version: string,
  ): Promise<PatternRecord | undefined> {
    await Promise.resolve();
    this.#guard.assertTenantAllowed(tenantId);
    return cloneOptional(this.#records.get(recordKey(tenantId, patternId, version)));
  }

  async getByDigest(tenantId: string, patternDigest: Digest): Promise<PatternRecord | undefined> {
    await Promise.resolve();
    this.#guard.assertTenantAllowed(tenantId);
    const key = this.#digests.get(recordKey(tenantId, patternDigest));
    return key === undefined ? undefined : cloneOptional(this.#records.get(key));
  }
}

function putImmutable<T>(
  records: Map<string, T>,
  digests: Map<string, string>,
  key: string,
  tenantId: string,
  digest: Digest,
  record: T,
): void {
  const existing = records.get(key);
  if (existing !== undefined) {
    if (sameJson(existing, record)) return;
    conflict("immutable_evidence_record_changed");
  }
  const digestKey = recordKey(tenantId, digest);
  const existingDigestKey = digests.get(digestKey);
  if (existingDigestKey !== undefined && existingDigestKey !== key) {
    conflict("evidence_digest_route_changed");
  }
  records.set(key, cloneJson(record));
  digests.set(digestKey, key);
}

function assertEvidenceDigest(record: EvidenceRecord): void {
  const { evidenceDigest, ...material } = record;
  if (evidenceDigest !== digestCanonicalJson(material)) conflict("evidence_digest_invalid");
}

function assertVerificationDigest(record: VerificationRecord): void {
  const { verificationDigest, ...material } = record.verification;
  if (verificationDigest !== digestCanonicalJson(material)) conflict("verification_digest_invalid");
}

function assertPatternDigest(record: PatternRecord): void {
  const { patternDigest, ...material } = record.pattern;
  if (patternDigest !== digestCanonicalJson(material)) conflict("pattern_digest_invalid");
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : cloneJson(value);
}
