import {
  AcceptedWorkOrderSchema,
  ArtifactSchema,
  ContextSnapshotSchema,
  digestBytes,
  digestCanonicalJson,
  InputSubmissionRecordSchema,
  KafError,
  ProtectedValueRefSchema,
  type AcceptedWorkOrder,
  type AcceptedWorkOrderStore,
  type Artifact,
  type ArtifactStore,
  type ContextSnapshot,
  type ContextStore,
  type DataProtector,
  type Digest,
  type InputSubmissionRecord,
  type InputSubmissionStore,
  type ProtectedValueRef,
  type RuntimeCapabilities,
  type StorageSecurityProfile,
} from "@pactmark/core";

import { POSTGRES_STORE_CAPABILITIES, PostgresStorageGuard } from "./config.js";
import type { PostgresDatabase } from "./database.js";
import { assertNonempty, assertNonnegative, conflict, parseJsonColumn } from "./internal.js";

type WorkOrderRow = {
  canonical_digest: string;
  protected_ref_json: unknown;
  work_order_kind?: string;
  work_order_binding_digest?: string;
  execution_definition_digest?: string;
  purpose_code?: string;
  purpose_registry_version?: string;
  data_class?: string;
};

type JsonRecordRow = {
  canonical_digest: string;
  record_json: unknown;
};

type ArtifactRow = {
  canonical_digest: string;
  artifact_json: unknown;
  content: Uint8Array | null;
  protected_ref_json: unknown;
};

export interface PostgresRecordStoreOptions {
  readonly dataProtector?: DataProtector;
  readonly maxInlineArtifactBytes?: number;
  readonly now?: () => string;
  readonly onDelete?: (record: ProtectedStoreDeletion) => void | Promise<void>;
}

export interface ProtectedStoreDeletion {
  readonly tenantId: string;
  readonly storeKind: "accepted_work_order" | "input_submission" | "context" | "artifact";
  readonly recordId: string;
  readonly reason: "explicit" | "expired";
}

abstract class GuardedPostgresStore {
  readonly capabilities: RuntimeCapabilities = POSTGRES_STORE_CAPABILITIES;
  readonly securityProfile: StorageSecurityProfile;
  protected readonly database: PostgresDatabase;
  protected readonly guard: PostgresStorageGuard;

  constructor(database: PostgresDatabase, securityProfile: StorageSecurityProfile) {
    this.database = database;
    this.securityProfile = securityProfile;
    this.guard = new PostgresStorageGuard(securityProfile);
  }
}

export class PostgresAcceptedWorkOrderStore
  extends GuardedPostgresStore
  implements AcceptedWorkOrderStore
{
  readonly #protector: DataProtector | undefined;
  readonly #onDelete: PostgresRecordStoreOptions["onDelete"];
  readonly #now: () => string;

  constructor(
    database: PostgresDatabase,
    securityProfile: StorageSecurityProfile,
    options: Pick<PostgresRecordStoreOptions, "dataProtector" | "onDelete" | "now"> = {},
  ) {
    super(database, securityProfile);
    this.#protector = options.dataProtector;
    this.#onDelete = options.onDelete;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async putImmutable(input: AcceptedWorkOrder): Promise<void> {
    const workOrder = AcceptedWorkOrderSchema.parse(input);
    this.guard.assertWriteAllowed(workOrder.tenant.id, workOrder.purpose.code, workOrder.dataClass);
    assertWorkOrderBindingDigest(workOrder);
    const canonicalDigest = digestCanonicalJson(workOrder);
    const expiresAt = workOrder.retention.mode === "until" ? workOrder.retention.expiresAt : null;
    const prior = await this.database.query<WorkOrderRow>(
      `SELECT canonical_digest,protected_ref_json FROM pactmark_work_orders
       WHERE tenant_id=$1 AND work_order_id=$2`,
      [workOrder.tenant.id, workOrder.id],
    );
    if (prior.rows[0] !== undefined) {
      if (prior.rows[0].canonical_digest === canonicalDigest) return;
      conflict("immutable_work_order_changed");
    }
    if (this.#protector === undefined) rejectSecurity("data_protector_required");
    const protectedReference = await this.#protector.protect(
      workOrderBinding(workOrder),
      new TextEncoder().encode(JSON.stringify(workOrder)),
    );

    const result = await this.database.query(
      `INSERT INTO pactmark_work_orders
        (tenant_id,work_order_id,work_order_kind,work_order_binding_digest,
         execution_definition_json,execution_definition_digest,model_security_profile_digest,
         model_resource_profile_digest,model_adapter_registration_digest,canonical_digest,data_class,
         purpose_code,expires_at,protected_ref_json,protected_key_id,protected_ref,
         original_run_id,original_effect_id,original_effect_digest,original_effect_result_digest,
         original_effect_acknowledgement_digest,compensation_strategy_digest,
         compensation_tool_id,compensation_tool_version,compensation_tool_registration_digest,
         principal_type,principal_id,purpose_registry_version,resource_scope_ceiling_json,
         max_active_execution_ms)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::jsonb,
         $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb,$30)
       ON CONFLICT (tenant_id,work_order_id) DO NOTHING`,
      [
        workOrder.tenant.id,
        workOrder.id,
        workOrder.kind,
        workOrder.workOrderBindingDigest,
        JSON.stringify(workOrder.executionDefinition),
        workOrder.executionDefinitionDigest,
        workOrder.kind === "agent" ? workOrder.modelSecurityProfileDigest : null,
        workOrder.kind === "agent" ? workOrder.modelResourceProfileDigest : null,
        workOrder.kind === "agent" ? workOrder.modelAdapterRegistrationDigest : null,
        canonicalDigest,
        workOrder.dataClass,
        workOrder.purpose.code,
        expiresAt,
        JSON.stringify(protectedReference),
        protectedReference.keyId,
        protectedReference.ciphertextRef,
        workOrder.kind === "compensation" ? workOrder.originalRunId : null,
        workOrder.kind === "compensation" ? workOrder.originalEffectId : null,
        workOrder.kind === "compensation" ? workOrder.originalEffectDigest : null,
        workOrder.kind === "compensation" ? workOrder.originalEffectResultDigest : null,
        workOrder.kind === "compensation" ? workOrder.originalEffectAcknowledgementDigest : null,
        workOrder.kind === "compensation" ? workOrder.compensationStrategyRegistrationDigest : null,
        workOrder.kind === "compensation" ? workOrder.compensationToolId : null,
        workOrder.kind === "compensation" ? workOrder.compensationToolVersion : null,
        workOrder.kind === "compensation" ? workOrder.compensationToolRegistrationDigest : null,
        workOrder.principal.type,
        workOrder.principal.id,
        workOrder.purpose.registryVersion,
        JSON.stringify(workOrder.resourceScopeCeiling),
        workOrder.budget.maxActiveExecutionMs,
      ],
    );
    if (result.rowCount === 1) return;
    const existing = await this.database.query<WorkOrderRow>(
      `SELECT canonical_digest,protected_ref_json FROM pactmark_work_orders
       WHERE tenant_id=$1 AND work_order_id=$2`,
      [workOrder.tenant.id, workOrder.id],
    );
    if (existing.rows[0]?.canonical_digest === canonicalDigest) return;
    conflict("immutable_work_order_changed");
  }

  async get(tenantId: string, workOrderId: string): Promise<AcceptedWorkOrder | undefined> {
    assertNonempty(tenantId, "tenantId");
    assertNonempty(workOrderId, "workOrderId");
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<WorkOrderRow>(
      `SELECT canonical_digest,protected_ref_json,work_order_kind,work_order_binding_digest,
              execution_definition_digest,purpose_code,purpose_registry_version,data_class
       FROM pactmark_work_orders
       WHERE tenant_id=$1 AND work_order_id=$2
         AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
      [tenantId, workOrderId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if (this.#protector === undefined) rejectSecurity("protected_work_order_unavailable");
    const reference = parseProtectedReference(row.protected_ref_json);
    const plaintext = await this.#protector.unprotect(
      {
        tenantId,
        recordId: workOrderId,
        storeKind: "accepted_work_order",
        schemaVersion: "1",
        purposeCode: requiredRowValue(row.purpose_code, "purpose_code"),
        purposeRegistryVersion: requiredRowValue(
          row.purpose_registry_version,
          "purpose_registry_version",
        ),
        dataClass: requiredRowValue(row.data_class, "data_class"),
        workOrderBindingDigest: requiredRowValue(
          row.work_order_binding_digest,
          "work_order_binding_digest",
        ),
        executionDefinitionDigest: requiredRowValue(
          row.execution_definition_digest,
          "execution_definition_digest",
        ),
        workOrderKind: requiredRowValue(row.work_order_kind, "work_order_kind"),
      },
      reference,
    );
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(plaintext));
    } catch (internalCause) {
      throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
        details: { reason: "protected_work_order_invalid" },
        internalCause,
      });
    }
    const workOrder = AcceptedWorkOrderSchema.parse(decoded);
    if (workOrder.tenant.id !== tenantId || workOrder.id !== workOrderId) {
      conflict("work_order_binding_changed");
    }
    assertWorkOrderBindingDigest(workOrder);
    if (digestCanonicalJson(workOrder) !== row.canonical_digest) {
      conflict("work_order_payload_changed");
    }
    return workOrder;
  }

  async delete(tenantId: string, workOrderId: string): Promise<void> {
    assertNonempty(tenantId, "tenantId");
    assertNonempty(workOrderId, "workOrderId");
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query(
      "DELETE FROM pactmark_work_orders WHERE tenant_id=$1 AND work_order_id=$2",
      [tenantId, workOrderId],
    );
    if (result.rowCount === 1) {
      await this.#onDelete?.({
        tenantId,
        storeKind: "accepted_work_order",
        recordId: workOrderId,
        reason: "explicit",
      });
    }
  }

  async purgeExpired(now = this.#now()): Promise<number> {
    const result = await this.database.query<{ tenant_id: string; work_order_id: string }>(
      `DELETE FROM pactmark_work_orders WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz
       RETURNING tenant_id,work_order_id`,
      [now],
    );
    for (const row of result.rows) {
      await this.#onDelete?.({
        tenantId: row.tenant_id,
        storeKind: "accepted_work_order",
        recordId: row.work_order_id,
        reason: "expired",
      });
    }
    return result.rowCount;
  }
}

export class PostgresInputSubmissionStore
  extends GuardedPostgresStore
  implements InputSubmissionStore
{
  readonly #protector: DataProtector | undefined;
  readonly #onDelete: PostgresRecordStoreOptions["onDelete"];
  readonly #now: () => string;

  constructor(
    database: PostgresDatabase,
    securityProfile: StorageSecurityProfile,
    options: Pick<PostgresRecordStoreOptions, "dataProtector" | "onDelete" | "now"> = {},
  ) {
    super(database, securityProfile);
    this.#protector = options.dataProtector;
    this.#onDelete = options.onDelete;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async putOnce(input: InputSubmissionRecord): Promise<InputSubmissionRecord> {
    const record = InputSubmissionRecordSchema.parse(input);
    this.guard.assertWriteAllowed(record.tenantId, record.purposeCode, record.dataClass);
    if (this.#protector === undefined) rejectSecurity("data_protector_required");
    const canonicalDigest = digestCanonicalJson(record);
    const expiresAt = record.retention.mode === "until" ? record.retention.expiresAt : null;
    const result = await this.database.query(
      `INSERT INTO pactmark_input_submissions
        (tenant_id,run_id,request_id,input_submission_record_id,input_schema_digest,value_digest,
         canonical_digest,purpose_code,data_class,consuming_command_id,expires_at,record_json,
         protected_key_id,protected_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12::jsonb,$13,$14)
       ON CONFLICT (tenant_id,run_id,request_id) DO NOTHING`,
      [
        record.tenantId,
        record.runId,
        record.requestId,
        record.inputSubmissionRecordId,
        record.inputSchemaDigest,
        record.valueDigest,
        canonicalDigest,
        record.purposeCode,
        record.dataClass,
        record.consumingCommandId,
        expiresAt,
        JSON.stringify(record),
        record.protectedValue.keyId,
        record.protectedValue.ciphertextRef,
      ],
    );
    if (result.rowCount === 0) {
      const existing = await this.getRow(record.tenantId, record.runId, record.requestId, false);
      if (existing === undefined || existing.canonical_digest !== canonicalDigest) {
        conflict("input_submission_changed");
      }
      return parseBoundInput(existing, record.tenantId, record.runId, record.requestId);
    }
    return record;
  }

  async get(
    tenantId: string,
    runId: string,
    requestId: string,
  ): Promise<InputSubmissionRecord | undefined> {
    const row = await this.getRow(tenantId, runId, requestId, true);
    return row === undefined ? undefined : parseBoundInput(row, tenantId, runId, requestId);
  }

  async delete(tenantId: string, runId: string, requestId: string): Promise<void> {
    validateRoute(tenantId, runId, requestId);
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query(
      "DELETE FROM pactmark_input_submissions WHERE tenant_id=$1 AND run_id=$2 AND request_id=$3",
      [tenantId, runId, requestId],
    );
    if (result.rowCount === 1) {
      await this.#onDelete?.({
        tenantId,
        storeKind: "input_submission",
        recordId: `${runId}/${requestId}`,
        reason: "explicit",
      });
    }
  }

  async purgeExpired(now = this.#now()): Promise<number> {
    const result = await this.database.query<{
      tenant_id: string;
      run_id: string;
      request_id: string;
    }>(
      `DELETE FROM pactmark_input_submissions
       WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz
       RETURNING tenant_id,run_id,request_id`,
      [now],
    );
    for (const row of result.rows) {
      await this.#onDelete?.({
        tenantId: row.tenant_id,
        storeKind: "input_submission",
        recordId: `${row.run_id}/${row.request_id}`,
        reason: "expired",
      });
    }
    return result.rowCount;
  }

  private async getRow(
    tenantId: string,
    runId: string,
    requestId: string,
    enforceExpiry: boolean,
  ): Promise<JsonRecordRow | undefined> {
    validateRoute(tenantId, runId, requestId);
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<JsonRecordRow>(
      `SELECT canonical_digest,record_json FROM pactmark_input_submissions
       WHERE tenant_id=$1 AND run_id=$2 AND request_id=$3
       ${enforceExpiry ? "AND (expires_at IS NULL OR expires_at > clock_timestamp())" : ""}`,
      [tenantId, runId, requestId],
    );
    return result.rows[0];
  }
}

export class PostgresContextStore extends GuardedPostgresStore implements ContextStore {
  readonly #protector: DataProtector | undefined;
  readonly #onDelete: PostgresRecordStoreOptions["onDelete"];
  readonly #now: () => string;

  constructor(
    database: PostgresDatabase,
    securityProfile: StorageSecurityProfile,
    options: Pick<PostgresRecordStoreOptions, "dataProtector" | "onDelete" | "now"> = {},
  ) {
    super(database, securityProfile);
    this.#protector = options.dataProtector;
    this.#onDelete = options.onDelete;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async put(input: ContextSnapshot): Promise<void> {
    const snapshot = ContextSnapshotSchema.parse(input);
    this.guard.assertWriteAllowed(snapshot.tenantId, snapshot.purposeCode, snapshot.dataClass);
    if (this.#protector === undefined) rejectSecurity("context_protector_required");
    const canonicalDigest = digestCanonicalJson(snapshot);
    const result = await this.database.query(
      `INSERT INTO pactmark_context_snapshots
        (tenant_id,run_id,snapshot_id,sequence,canonical_digest,purpose_code,data_class,
         expires_at,snapshot_json,protected_key_id,protected_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::jsonb,$10,$11)
       ON CONFLICT (tenant_id,run_id,snapshot_id) DO NOTHING`,
      [
        snapshot.tenantId,
        snapshot.runId,
        snapshot.snapshotId,
        snapshot.sequence,
        canonicalDigest,
        snapshot.purposeCode,
        snapshot.dataClass,
        snapshot.expiresAt ?? null,
        JSON.stringify(snapshot),
        snapshot.protectedValue.keyId,
        snapshot.protectedValue.ciphertextRef,
      ],
    );
    if (result.rowCount === 1) return;
    const existing = await this.database.query<JsonRecordRow>(
      `SELECT canonical_digest,snapshot_json AS record_json FROM pactmark_context_snapshots
       WHERE tenant_id=$1 AND run_id=$2 AND snapshot_id=$3`,
      [snapshot.tenantId, snapshot.runId, snapshot.snapshotId],
    );
    if (existing.rows[0]?.canonical_digest !== canonicalDigest) {
      conflict("context_snapshot_changed");
    }
  }

  async getLatest(tenantId: string, runId: string): Promise<ContextSnapshot | undefined> {
    assertNonempty(tenantId, "tenantId");
    assertNonempty(runId, "runId");
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<JsonRecordRow>(
      `SELECT canonical_digest,snapshot_json AS record_json FROM pactmark_context_snapshots
       WHERE tenant_id=$1 AND run_id=$2
         AND (expires_at IS NULL OR expires_at > clock_timestamp())
       ORDER BY sequence DESC,snapshot_id DESC LIMIT 1`,
      [tenantId, runId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const snapshot = ContextSnapshotSchema.parse(parseJsonColumn(row.record_json));
    if (snapshot.tenantId !== tenantId || snapshot.runId !== runId) {
      conflict("context_snapshot_binding_changed");
    }
    if (digestCanonicalJson(snapshot) !== row.canonical_digest) {
      conflict("context_snapshot_payload_changed");
    }
    return snapshot;
  }

  async delete(tenantId: string, runId: string): Promise<void> {
    assertNonempty(tenantId, "tenantId");
    assertNonempty(runId, "runId");
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<{ snapshot_id: string }>(
      `DELETE FROM pactmark_context_snapshots WHERE tenant_id=$1 AND run_id=$2
       RETURNING snapshot_id`,
      [tenantId, runId],
    );
    for (const row of result.rows) {
      await this.#onDelete?.({
        tenantId,
        storeKind: "context",
        recordId: row.snapshot_id,
        reason: "explicit",
      });
    }
  }

  async putProtected(
    input: Omit<ContextSnapshot, "protectedValue">,
    plaintextInput: Uint8Array,
  ): Promise<ContextSnapshot> {
    if (this.#protector === undefined) rejectSecurity("context_protector_required");
    const plaintext = new Uint8Array(plaintextInput);
    if (plaintext.byteLength !== input.byteSize || digestBytes(plaintext) !== input.contextDigest) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "context", issue: "digest_or_size_mismatch" },
      });
    }
    const snapshot = ContextSnapshotSchema.parse({
      ...input,
      protectedValue: await this.#protector.protect(contextBinding(input), plaintext),
    });
    await this.put(snapshot);
    return snapshot;
  }

  async getLatestProtected(
    tenantId: string,
    runId: string,
  ): Promise<{ snapshot: ContextSnapshot; plaintext: Uint8Array } | undefined> {
    if (this.#protector === undefined) rejectSecurity("context_protector_required");
    const snapshot = await this.getLatest(tenantId, runId);
    if (snapshot === undefined) return undefined;
    const plaintext = await this.#protector.unprotect(
      contextBinding(snapshot),
      snapshot.protectedValue,
    );
    if (
      plaintext.byteLength !== snapshot.byteSize ||
      digestBytes(plaintext) !== snapshot.contextDigest
    ) {
      conflict("context_plaintext_changed");
    }
    return { snapshot, plaintext: new Uint8Array(plaintext) };
  }

  async purgeExpired(now = this.#now()): Promise<number> {
    const result = await this.database.query<{ tenant_id: string; snapshot_id: string }>(
      `DELETE FROM pactmark_context_snapshots
       WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz
       RETURNING tenant_id,snapshot_id`,
      [now],
    );
    for (const row of result.rows) {
      await this.#onDelete?.({
        tenantId: row.tenant_id,
        storeKind: "context",
        recordId: row.snapshot_id,
        reason: "expired",
      });
    }
    return result.rowCount;
  }
}

export class PostgresArtifactStore extends GuardedPostgresStore implements ArtifactStore {
  readonly #protector: DataProtector | undefined;
  readonly #maxInlineBytes: number;
  readonly #onDelete: PostgresRecordStoreOptions["onDelete"];
  readonly #now: () => string;

  constructor(
    database: PostgresDatabase,
    securityProfile: StorageSecurityProfile,
    options: PostgresRecordStoreOptions = {},
  ) {
    super(database, securityProfile);
    this.#protector = options.dataProtector;
    this.#maxInlineBytes = options.maxInlineArtifactBytes ?? 256 * 1024;
    assertNonnegative(this.#maxInlineBytes, "maxInlineArtifactBytes");
    this.#onDelete = options.onDelete;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async put(input: Artifact, contentInput: Uint8Array): Promise<void> {
    const artifact = ArtifactSchema.parse(input);
    const content = new Uint8Array(contentInput);
    this.guard.assertWriteAllowed(artifact.tenantId, artifact.purposeCode, artifact.dataClass);
    validateArtifactContent(artifact, content, this.#maxInlineBytes);
    const prior = await this.get(artifact.tenantId, artifact.artifactId);
    if (prior !== undefined) {
      if (
        digestCanonicalJson(prior.artifact) === digestCanonicalJson(artifact) &&
        digestBytes(prior.content) === artifact.contentDigest
      ) {
        return;
      }
      conflict("artifact_changed");
    }
    let storedContent: Uint8Array | null = content;
    let protectedReference: ProtectedValueRef | undefined;
    if (isSensitive(artifact.dataClass)) {
      if (this.#protector === undefined) rejectSecurity("data_protector_required");
      protectedReference = await this.#protector.protect(artifactBinding(artifact), content);
      storedContent = null;
    }
    const canonicalDigest = digestCanonicalJson(artifact);
    const result = await this.database.query(
      `INSERT INTO pactmark_artifacts
        (tenant_id,artifact_id,canonical_digest,content_digest,data_class,purpose_code,
         expires_at,artifact_json,content,protected_ref_json,protected_key_id,protected_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::jsonb,$9,$10::jsonb,$11,$12)
       ON CONFLICT (tenant_id,artifact_id) DO NOTHING`,
      [
        artifact.tenantId,
        artifact.artifactId,
        canonicalDigest,
        artifact.contentDigest,
        artifact.dataClass,
        artifact.purposeCode,
        artifact.expiresAt ?? null,
        JSON.stringify(artifact),
        storedContent,
        protectedReference === undefined ? null : JSON.stringify(protectedReference),
        protectedReference?.keyId ?? null,
        protectedReference?.ciphertextRef ?? null,
      ],
    );
    if (result.rowCount === 1) return;
    const existing = await this.get(artifact.tenantId, artifact.artifactId);
    if (
      existing !== undefined &&
      digestCanonicalJson(existing.artifact) === canonicalDigest &&
      digestBytes(existing.content) === artifact.contentDigest
    )
      return;
    conflict("artifact_changed");
  }

  async get(
    tenantId: string,
    artifactId: string,
  ): Promise<{ artifact: Artifact; content: Uint8Array } | undefined> {
    assertNonempty(tenantId, "tenantId");
    assertNonempty(artifactId, "artifactId");
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<ArtifactRow>(
      `SELECT canonical_digest,artifact_json,content,protected_ref_json FROM pactmark_artifacts
       WHERE tenant_id=$1 AND artifact_id=$2
         AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
      [tenantId, artifactId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const artifact = ArtifactSchema.parse(parseJsonColumn(row.artifact_json));
    if (artifact.tenantId !== tenantId || artifact.artifactId !== artifactId) {
      conflict("artifact_binding_changed");
    }
    if (digestCanonicalJson(artifact) !== row.canonical_digest) conflict("artifact_changed");
    let content: Uint8Array;
    if (row.content !== null) {
      content = new Uint8Array(row.content);
    } else {
      if (row.protected_ref_json === null || this.#protector === undefined) {
        rejectSecurity("protected_artifact_unavailable");
      }
      content = await this.#protector.unprotect(
        artifactBinding(artifact),
        parseProtectedReference(row.protected_ref_json),
      );
    }
    if (
      content.byteLength !== artifact.byteSize ||
      digestBytes(content) !== artifact.contentDigest
    ) {
      conflict("artifact_content_changed");
    }
    return { artifact, content: new Uint8Array(content) };
  }

  async delete(tenantId: string, artifactId: string): Promise<void> {
    assertNonempty(tenantId, "tenantId");
    assertNonempty(artifactId, "artifactId");
    this.guard.assertTenantAllowed(tenantId);
    const result = await this.database.query(
      "DELETE FROM pactmark_artifacts WHERE tenant_id=$1 AND artifact_id=$2",
      [tenantId, artifactId],
    );
    if (result.rowCount === 1) {
      await this.#onDelete?.({
        tenantId,
        storeKind: "artifact",
        recordId: artifactId,
        reason: "explicit",
      });
    }
  }

  async purgeExpired(now = this.#now()): Promise<number> {
    const result = await this.database.query<{ tenant_id: string; artifact_id: string }>(
      `DELETE FROM pactmark_artifacts WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz
       RETURNING tenant_id,artifact_id`,
      [now],
    );
    for (const row of result.rows) {
      await this.#onDelete?.({
        tenantId: row.tenant_id,
        storeKind: "artifact",
        recordId: row.artifact_id,
        reason: "expired",
      });
    }
    return result.rowCount;
  }
}

function parseBoundInput(
  row: JsonRecordRow,
  tenantId: string,
  runId: string,
  requestId: string,
): InputSubmissionRecord {
  const record = InputSubmissionRecordSchema.parse(parseJsonColumn(row.record_json));
  if (record.tenantId !== tenantId || record.runId !== runId || record.requestId !== requestId) {
    conflict("input_submission_binding_changed");
  }
  if (digestCanonicalJson(record) !== row.canonical_digest) {
    conflict("input_submission_payload_changed");
  }
  return record;
}

function validateRoute(...parts: readonly string[]): void {
  parts.forEach((part, index) => {
    assertNonempty(part, `route[${String(index)}]`);
  });
}

function isSensitive(dataClass: string): boolean {
  return dataClass === "confidential" || dataClass === "restricted";
}

function workOrderBinding(workOrder: AcceptedWorkOrder): Readonly<Record<string, string>> {
  return {
    tenantId: workOrder.tenant.id,
    recordId: workOrder.id,
    storeKind: "accepted_work_order",
    schemaVersion: workOrder.schemaVersion,
    purposeCode: workOrder.purpose.code,
    purposeRegistryVersion: workOrder.purpose.registryVersion,
    dataClass: workOrder.dataClass,
    workOrderBindingDigest: workOrder.workOrderBindingDigest,
    executionDefinitionDigest: workOrder.executionDefinitionDigest,
    workOrderKind: workOrder.kind,
  };
}

function artifactBinding(artifact: Artifact): Readonly<Record<string, string>> {
  return {
    tenantId: artifact.tenantId,
    recordId: artifact.artifactId,
    contentDigest: artifact.contentDigest,
    storeKind: "artifact",
    schemaVersion: artifact.schemaVersion,
    purposeCode: artifact.purposeCode,
    dataClass: artifact.dataClass,
    producingRunId: artifact.producingRunId,
    producingStepId: artifact.producingStepId,
    executionDefinitionDigest: artifact.provenance.executionDefinitionDigest,
    workOrderBindingDigest: artifact.provenance.workOrderBindingDigest,
  };
}

function contextBinding(
  snapshot: Omit<ContextSnapshot, "protectedValue"> | ContextSnapshot,
): Readonly<Record<string, string>> {
  return {
    tenantId: snapshot.tenantId,
    recordId: snapshot.snapshotId,
    storeKind: "context",
    schemaVersion: snapshot.schemaVersion,
    purposeCode: snapshot.purposeCode,
    purposeRegistryVersion: snapshot.purposeRegistryVersion,
    dataClass: snapshot.dataClass,
    runId: snapshot.runId,
    stepId: snapshot.stepId,
    sequence: String(snapshot.sequence),
    executionDefinitionDigest: snapshot.executionDefinitionDigest,
    workOrderBindingDigest: snapshot.workOrderBindingDigest,
    contextSchemaDigest: snapshot.contextSchemaDigest,
    contextDigest: snapshot.contextDigest,
  };
}

export function computeAcceptedWorkOrderBindingDigest(workOrder: AcceptedWorkOrder): Digest {
  const { workOrderBindingDigest, ...material } = workOrder;
  void workOrderBindingDigest;
  return digestCanonicalJson(material);
}

function assertWorkOrderBindingDigest(workOrder: AcceptedWorkOrder): void {
  if (computeAcceptedWorkOrderBindingDigest(workOrder) !== workOrder.workOrderBindingDigest) {
    conflict("work_order_binding_digest_mismatch");
  }
}

function parseProtectedReference(value: unknown): ProtectedValueRef {
  try {
    return ProtectedValueRefSchema.parse(parseJsonColumn(value));
  } catch (internalCause) {
    throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
      details: { reason: "protected_reference_invalid" },
      internalCause,
    });
  }
}

function validateArtifactContent(
  artifact: Artifact,
  content: Uint8Array,
  maxInlineBytes: number,
): void {
  if (artifact.byteSize !== content.byteLength || artifact.contentDigest !== digestBytes(content)) {
    throw new KafError("KAF_SCHEMA_INVALID", {
      details: { path: "artifact.content", issue: "digest_or_size_mismatch" },
    });
  }
  if (artifact.location.kind === "inline") {
    if (isSensitive(artifact.dataClass)) {
      rejectSecurity("sensitive_artifact_must_use_protected_store_location");
    }
    if (content.byteLength > maxInlineBytes) {
      throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
        details: { reason: "inline_artifact_too_large", maxInlineBytes },
      });
    }
    if (digestBytes(decodeInlineContent(artifact.location)) !== artifact.contentDigest) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "artifact.location.content", issue: "content_mismatch" },
      });
    }
  }
}

function decodeInlineContent(
  location: Extract<Artifact["location"], { kind: "inline" }>,
): Uint8Array {
  if (location.encoding === "utf8") return new TextEncoder().encode(location.content);
  try {
    return Uint8Array.from(Buffer.from(location.content, "base64"));
  } catch (internalCause) {
    throw new KafError("KAF_SCHEMA_INVALID", {
      details: { path: "artifact.location.content", issue: "invalid_base64" },
      internalCause,
    });
  }
}

function rejectSecurity(reason: string): never {
  throw new KafError("KAF_STORAGE_SECURITY_PROFILE", { details: { reason } });
}

function requiredRowValue(value: string | undefined, field: string): string {
  if (value === undefined || value.length === 0) rejectSecurity(`protected_row_${field}_missing`);
  return value;
}
