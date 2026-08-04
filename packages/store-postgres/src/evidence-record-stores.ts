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

import { POSTGRES_STORE_CAPABILITIES, PostgresStorageGuard } from "./config.js";
import type { PostgresDatabase } from "./database.js";
import { assertNonempty, conflict, parseJsonColumn } from "./internal.js";

type ImmutableRecordRow = {
  canonical_digest: string;
  record_json: unknown;
};

abstract class ImmutablePostgresRecordStore {
  readonly capabilities: RuntimeCapabilities = POSTGRES_STORE_CAPABILITIES;
  protected readonly guard: PostgresStorageGuard;

  constructor(
    protected readonly database: PostgresDatabase,
    securityProfile: StorageSecurityProfile,
  ) {
    this.guard = new PostgresStorageGuard(securityProfile);
  }

  protected async insertImmutable(
    insertSql: string,
    insertValues: readonly unknown[],
    routeSql: string,
    routeValues: readonly unknown[],
    canonicalDigest: Digest,
    conflictReason: string,
  ): Promise<void> {
    const result = await this.database.query(insertSql, insertValues);
    if (result.rowCount === 1) return;
    const existing = await this.database.query<ImmutableRecordRow>(routeSql, routeValues);
    if (existing.rows[0]?.canonical_digest === canonicalDigest) return;
    conflict(conflictReason);
  }
}

export class PostgresEvidenceRecordStore
  extends ImmutablePostgresRecordStore
  implements EvidenceRecordStore
{
  async putImmutable(input: EvidenceRecord): Promise<void> {
    const record = EvidenceRecordSchema.parse(input);
    this.guard.assertWriteAllowed(
      record.tenantId,
      record.permission.purposeCode,
      record.permission.dataClass,
    );
    assertEvidenceDigest(record);
    const canonicalDigest = digestCanonicalJson(record);
    await this.insertImmutable(
      `INSERT INTO pactmark_evidence_records
        (tenant_id,evidence_record_id,run_id,evidence_digest,canonical_digest,record_json)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        record.tenantId,
        record.evidenceRecordId,
        record.runId,
        record.evidenceDigest,
        canonicalDigest,
        JSON.stringify(record),
      ],
      `SELECT canonical_digest,record_json FROM pactmark_evidence_records
       WHERE tenant_id=$1 AND evidence_record_id=$2`,
      [record.tenantId, record.evidenceRecordId],
      canonicalDigest,
      "immutable_evidence_record_changed",
    );
  }

  async get(tenantId: string, evidenceRecordId: string): Promise<EvidenceRecord | undefined> {
    validateRoute(tenantId, evidenceRecordId);
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<ImmutableRecordRow>(
      `SELECT canonical_digest,record_json FROM pactmark_evidence_records
       WHERE tenant_id=$1 AND evidence_record_id=$2`,
      [tenantId, evidenceRecordId],
    );
    return parseEvidenceRow(result.rows[0], tenantId, evidenceRecordId);
  }

  async getByDigest(tenantId: string, evidenceDigest: Digest): Promise<EvidenceRecord | undefined> {
    validateRoute(tenantId, evidenceDigest);
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<ImmutableRecordRow>(
      `SELECT canonical_digest,record_json FROM pactmark_evidence_records
       WHERE tenant_id=$1 AND evidence_digest=$2`,
      [tenantId, evidenceDigest],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const record = parseEvidenceRow(row, tenantId);
    if (record?.evidenceDigest !== evidenceDigest) conflict("evidence_digest_route_changed");
    return record;
  }
}

export class PostgresVerificationRecordStore
  extends ImmutablePostgresRecordStore
  implements VerificationRecordStore
{
  async putImmutable(input: VerificationRecord): Promise<void> {
    const record = VerificationRecordSchema.parse(input);
    this.guard.assertWriteAllowed(record.tenantId, record.purposeCode, record.dataClass);
    assertVerificationDigest(record);
    const canonicalDigest = digestCanonicalJson(record);
    await this.insertImmutable(
      `INSERT INTO pactmark_verification_records
        (tenant_id,run_id,verification_id,verification_digest,canonical_digest,record_json)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        record.tenantId,
        record.runId,
        record.verification.verificationId,
        record.verification.verificationDigest,
        canonicalDigest,
        JSON.stringify(record),
      ],
      `SELECT canonical_digest,record_json FROM pactmark_verification_records
       WHERE tenant_id=$1 AND run_id=$2 AND verification_id=$3`,
      [record.tenantId, record.runId, record.verification.verificationId],
      canonicalDigest,
      "immutable_verification_record_changed",
    );
  }

  async get(
    tenantId: string,
    runId: string,
    verificationId: string,
  ): Promise<VerificationRecord | undefined> {
    validateRoute(tenantId, runId, verificationId);
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<ImmutableRecordRow>(
      `SELECT canonical_digest,record_json FROM pactmark_verification_records
       WHERE tenant_id=$1 AND run_id=$2 AND verification_id=$3`,
      [tenantId, runId, verificationId],
    );
    return parseVerificationRow(result.rows[0], tenantId, runId, verificationId);
  }

  async getByDigest(
    tenantId: string,
    verificationDigest: Digest,
  ): Promise<VerificationRecord | undefined> {
    validateRoute(tenantId, verificationDigest);
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<ImmutableRecordRow>(
      `SELECT canonical_digest,record_json FROM pactmark_verification_records
       WHERE tenant_id=$1 AND verification_digest=$2`,
      [tenantId, verificationDigest],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const record = parseVerificationRow(row, tenantId);
    if (record?.verification.verificationDigest !== verificationDigest) {
      conflict("verification_digest_route_changed");
    }
    return record;
  }
}

export class PostgresPatternRecordStore
  extends ImmutablePostgresRecordStore
  implements PatternRecordStore
{
  async putImmutable(input: PatternRecord): Promise<void> {
    const record = PatternRecordSchema.parse(input);
    this.guard.assertWriteAllowed(record.tenantId, record.purposeCode, record.dataClass);
    assertPatternDigest(record);
    const canonicalDigest = digestCanonicalJson(record);
    await this.insertImmutable(
      `INSERT INTO pactmark_pattern_records
        (tenant_id,pattern_id,pattern_version,pattern_digest,canonical_digest,record_json)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        record.tenantId,
        record.pattern.patternId,
        record.pattern.version,
        record.pattern.patternDigest,
        canonicalDigest,
        JSON.stringify(record),
      ],
      `SELECT canonical_digest,record_json FROM pactmark_pattern_records
       WHERE tenant_id=$1 AND pattern_id=$2 AND pattern_version=$3`,
      [record.tenantId, record.pattern.patternId, record.pattern.version],
      canonicalDigest,
      "immutable_pattern_record_changed",
    );
  }

  async get(
    tenantId: string,
    patternId: string,
    version: string,
  ): Promise<PatternRecord | undefined> {
    validateRoute(tenantId, patternId, version);
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<ImmutableRecordRow>(
      `SELECT canonical_digest,record_json FROM pactmark_pattern_records
       WHERE tenant_id=$1 AND pattern_id=$2 AND pattern_version=$3`,
      [tenantId, patternId, version],
    );
    return parsePatternRow(result.rows[0], tenantId, patternId, version);
  }

  async getByDigest(tenantId: string, patternDigest: Digest): Promise<PatternRecord | undefined> {
    validateRoute(tenantId, patternDigest);
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<ImmutableRecordRow>(
      `SELECT canonical_digest,record_json FROM pactmark_pattern_records
       WHERE tenant_id=$1 AND pattern_digest=$2`,
      [tenantId, patternDigest],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const record = parsePatternRow(row, tenantId);
    if (record?.pattern.patternDigest !== patternDigest) conflict("pattern_digest_route_changed");
    return record;
  }
}

function parseEvidenceRow(
  row: ImmutableRecordRow | undefined,
  tenantId: string,
  evidenceRecordId?: string,
): EvidenceRecord | undefined {
  if (row === undefined) return undefined;
  const record = EvidenceRecordSchema.parse(parseJsonColumn(row.record_json));
  if (
    record.tenantId !== tenantId ||
    (evidenceRecordId !== undefined && record.evidenceRecordId !== evidenceRecordId)
  ) {
    conflict("evidence_record_binding_changed");
  }
  assertEvidenceDigest(record);
  if (digestCanonicalJson(record) !== row.canonical_digest) conflict("evidence_record_changed");
  return record;
}

function parseVerificationRow(
  row: ImmutableRecordRow | undefined,
  tenantId: string,
  runId?: string,
  verificationId?: string,
): VerificationRecord | undefined {
  if (row === undefined) return undefined;
  const record = VerificationRecordSchema.parse(parseJsonColumn(row.record_json));
  if (
    record.tenantId !== tenantId ||
    (runId !== undefined && record.runId !== runId) ||
    (verificationId !== undefined && record.verification.verificationId !== verificationId)
  ) {
    conflict("verification_record_binding_changed");
  }
  assertVerificationDigest(record);
  if (digestCanonicalJson(record) !== row.canonical_digest) conflict("verification_record_changed");
  return record;
}

function parsePatternRow(
  row: ImmutableRecordRow | undefined,
  tenantId: string,
  patternId?: string,
  version?: string,
): PatternRecord | undefined {
  if (row === undefined) return undefined;
  const record = PatternRecordSchema.parse(parseJsonColumn(row.record_json));
  if (
    record.tenantId !== tenantId ||
    (patternId !== undefined && record.pattern.patternId !== patternId) ||
    (version !== undefined && record.pattern.version !== version)
  ) {
    conflict("pattern_record_binding_changed");
  }
  assertPatternDigest(record);
  if (digestCanonicalJson(record) !== row.canonical_digest) conflict("pattern_record_changed");
  return record;
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

function validateRoute(...parts: readonly string[]): void {
  parts.forEach((part, index) => {
    assertNonempty(part, `route[${String(index)}]`);
  });
}
