import {
  AcceptedWorkOrderSchema,
  ArtifactSchema,
  ContextSnapshotSchema,
  digestBytes,
  digestCanonicalJson,
  InputSubmissionRecordSchema,
  KafError,
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

import {
  createMemoryStorageSecurityProfile,
  MEMORY_STORE_CAPABILITIES,
  MemoryStorageGuard,
  type MemoryStorageProfileOptions,
} from "./config.js";
import {
  cloneJson,
  conflict,
  hasExpired,
  recordKey,
  sameJson,
  systemNow,
  type Now,
} from "./internal.js";

interface CommonStoreOptions extends MemoryStorageProfileOptions {
  readonly securityProfile?: StorageSecurityProfile;
  readonly now?: Now;
}

interface ProtectedStoreOptions extends CommonStoreOptions {
  readonly dataProtector?: DataProtector;
}

type ProtectedWorkOrderRecord = Readonly<{
  canonicalDigest: string;
  dataClass: AcceptedWorkOrder["dataClass"];
  expiresAt?: string;
  value?: AcceptedWorkOrder;
  protectedValue?: ProtectedValueRef;
}>;

export class MemoryAcceptedWorkOrderStore implements AcceptedWorkOrderStore {
  readonly capabilities: RuntimeCapabilities = MEMORY_STORE_CAPABILITIES;
  readonly securityProfile: StorageSecurityProfile;
  readonly #records = new Map<string, ProtectedWorkOrderRecord>();
  readonly #guard: MemoryStorageGuard;
  readonly #protector: DataProtector | undefined;
  readonly #now: Now;

  constructor(options: ProtectedStoreOptions = {}) {
    this.securityProfile = options.securityProfile ?? createMemoryStorageSecurityProfile(options);
    this.#guard = new MemoryStorageGuard(this.securityProfile);
    this.#protector = options.dataProtector;
    this.#now = options.now ?? systemNow;
  }

  async putImmutable(input: AcceptedWorkOrder): Promise<void> {
    const workOrder = AcceptedWorkOrderSchema.parse(input);
    this.#guard.assertWriteAllowed(
      workOrder.tenant.id,
      workOrder.purpose.code,
      workOrder.dataClass,
    );
    assertWorkOrderBindingDigest(workOrder);
    const key = recordKey(workOrder.tenant.id, workOrder.id);
    const canonicalDigest = digestCanonicalJson(workOrder);
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (existing.canonicalDigest === canonicalDigest) return;
      conflict("immutable_work_order_changed");
    }

    const expiresAt =
      workOrder.retention.mode === "until" ? workOrder.retention.expiresAt : undefined;
    if (isSensitive(workOrder.dataClass)) {
      if (this.#protector === undefined) this.rejectUnprotected();
      const binding = workOrderBinding(workOrder);
      const plaintext = new TextEncoder().encode(JSON.stringify(workOrder));
      const protectedValue = await this.#protector.protect(binding, plaintext);
      this.#records.set(key, {
        canonicalDigest,
        dataClass: workOrder.dataClass,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        protectedValue,
      });
      return;
    }
    this.#records.set(key, {
      canonicalDigest,
      dataClass: workOrder.dataClass,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      value: cloneJson(workOrder),
    });
  }

  async get(tenantId: string, workOrderId: string): Promise<AcceptedWorkOrder | undefined> {
    const key = recordKey(tenantId, workOrderId);
    const record = this.#records.get(key);
    if (record === undefined) return undefined;
    if (hasExpired(record.expiresAt, this.#now())) {
      this.#records.delete(key);
      return undefined;
    }
    let value: AcceptedWorkOrder;
    if (record.value !== undefined) {
      value = cloneJson(record.value);
    } else {
      if (record.protectedValue === undefined || this.#protector === undefined) {
        throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
          details: { reason: "protected_work_order_unavailable" },
        });
      }
      const plaintext = await this.#protector.unprotect(
        { tenantId, workOrderId, storeKind: "accepted_work_order", schemaVersion: "1" },
        record.protectedValue,
      );
      try {
        value = AcceptedWorkOrderSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
      } catch (internalCause) {
        throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
          details: { reason: "protected_work_order_invalid" },
          internalCause,
        });
      }
    }
    if (value.tenant.id !== tenantId || value.id !== workOrderId)
      conflict("work_order_binding_changed");
    assertWorkOrderBindingDigest(value);
    if (digestCanonicalJson(value) !== record.canonicalDigest)
      conflict("work_order_payload_changed");
    return cloneJson(value);
  }

  async delete(tenantId: string, workOrderId: string): Promise<void> {
    await Promise.resolve();
    this.#records.delete(recordKey(tenantId, workOrderId));
  }

  purgeExpired(at = this.#now()): number {
    let removed = 0;
    for (const [key, record] of this.#records) {
      if (hasExpired(record.expiresAt, at)) {
        this.#records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  transactionSnapshot(): Map<string, ProtectedWorkOrderRecord> {
    return structuredClone(this.#records);
  }

  transactionRestore(snapshot: Map<string, ProtectedWorkOrderRecord>): void {
    replaceMap(this.#records, snapshot);
  }

  private rejectUnprotected(): never {
    throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
      details: { reason: "data_protector_required" },
    });
  }
}

export class MemoryInputSubmissionStore implements InputSubmissionStore {
  readonly capabilities: RuntimeCapabilities = MEMORY_STORE_CAPABILITIES;
  readonly securityProfile: StorageSecurityProfile;
  readonly #records = new Map<string, InputSubmissionRecord>();
  readonly #guard: MemoryStorageGuard;
  readonly #now: Now;

  constructor(options: CommonStoreOptions = {}) {
    this.securityProfile = options.securityProfile ?? createMemoryStorageSecurityProfile(options);
    this.#guard = new MemoryStorageGuard(this.securityProfile);
    this.#now = options.now ?? systemNow;
  }

  async putOnce(input: InputSubmissionRecord): Promise<InputSubmissionRecord> {
    await Promise.resolve();
    const record = InputSubmissionRecordSchema.parse(input);
    this.#guard.assertWriteAllowed(record.tenantId, record.purposeCode, record.dataClass);
    const key = recordKey(record.tenantId, record.runId, record.requestId);
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (sameJson(existing, record)) return cloneJson(existing);
      conflict("input_submission_changed");
    }
    this.#records.set(key, cloneJson(record));
    return cloneJson(record);
  }

  async get(
    tenantId: string,
    runId: string,
    requestId: string,
  ): Promise<InputSubmissionRecord | undefined> {
    await Promise.resolve();
    const key = recordKey(tenantId, runId, requestId);
    const record = this.#records.get(key);
    if (record === undefined) return undefined;
    const expiresAt = record.retention.mode === "until" ? record.retention.expiresAt : undefined;
    if (hasExpired(expiresAt, this.#now())) {
      this.#records.delete(key);
      return undefined;
    }
    return cloneJson(record);
  }

  async delete(tenantId: string, runId: string, requestId: string): Promise<void> {
    await Promise.resolve();
    this.#records.delete(recordKey(tenantId, runId, requestId));
  }

  purgeExpired(at = this.#now()): number {
    let removed = 0;
    for (const [key, record] of this.#records) {
      const expiresAt = record.retention.mode === "until" ? record.retention.expiresAt : undefined;
      if (hasExpired(expiresAt, at)) {
        this.#records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  transactionSnapshot(): Map<string, InputSubmissionRecord> {
    return structuredClone(this.#records);
  }

  transactionRestore(snapshot: Map<string, InputSubmissionRecord>): void {
    replaceMap(this.#records, snapshot);
  }
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

export class MemoryContextStore implements ContextStore {
  readonly capabilities: RuntimeCapabilities = MEMORY_STORE_CAPABILITIES;
  readonly securityProfile: StorageSecurityProfile;
  readonly #snapshots = new Map<string, Map<string, ContextSnapshot>>();
  readonly #guard: MemoryStorageGuard;
  readonly #now: Now;

  constructor(options: CommonStoreOptions = {}) {
    this.securityProfile = options.securityProfile ?? createMemoryStorageSecurityProfile(options);
    this.#guard = new MemoryStorageGuard(this.securityProfile);
    this.#now = options.now ?? systemNow;
  }

  async put(input: ContextSnapshot): Promise<void> {
    await Promise.resolve();
    const snapshot = ContextSnapshotSchema.parse(input);
    this.#guard.assertWriteAllowed(snapshot.tenantId, snapshot.purposeCode, snapshot.dataClass);
    const streamKey = recordKey(snapshot.tenantId, snapshot.runId);
    const stream = this.#snapshots.get(streamKey) ?? new Map<string, ContextSnapshot>();
    const existing = stream.get(snapshot.snapshotId);
    if (existing !== undefined) {
      if (sameJson(existing, snapshot)) return;
      conflict("context_snapshot_changed");
    }
    stream.set(snapshot.snapshotId, cloneJson(snapshot));
    this.#snapshots.set(streamKey, stream);
  }

  async getLatest(tenantId: string, runId: string): Promise<ContextSnapshot | undefined> {
    await Promise.resolve();
    const streamKey = recordKey(tenantId, runId);
    const stream = this.#snapshots.get(streamKey);
    if (stream === undefined) return undefined;
    let latest: ContextSnapshot | undefined;
    for (const [snapshotId, snapshot] of stream) {
      if (hasExpired(snapshot.expiresAt, this.#now())) {
        stream.delete(snapshotId);
      } else if (
        latest === undefined ||
        snapshot.sequence > latest.sequence ||
        (snapshot.sequence === latest.sequence && snapshot.snapshotId > latest.snapshotId)
      ) {
        latest = snapshot;
      }
    }
    if (stream.size === 0) this.#snapshots.delete(streamKey);
    return latest === undefined ? undefined : cloneJson(latest);
  }

  async delete(tenantId: string, runId: string): Promise<void> {
    await Promise.resolve();
    this.#snapshots.delete(recordKey(tenantId, runId));
  }

  purgeExpired(at = this.#now()): number {
    let removed = 0;
    for (const [streamKey, stream] of this.#snapshots) {
      for (const [snapshotId, snapshot] of stream) {
        if (hasExpired(snapshot.expiresAt, at)) {
          stream.delete(snapshotId);
          removed += 1;
        }
      }
      if (stream.size === 0) this.#snapshots.delete(streamKey);
    }
    return removed;
  }

  transactionSnapshot(): Map<string, Map<string, ContextSnapshot>> {
    return structuredClone(this.#snapshots);
  }

  transactionRestore(snapshot: Map<string, Map<string, ContextSnapshot>>): void {
    replaceMap(this.#snapshots, snapshot);
  }
}

interface ArtifactStoreOptions extends ProtectedStoreOptions {
  readonly maxInlineBytes?: number;
}

type ArtifactRecord = Readonly<{
  artifact: Artifact;
  content?: Uint8Array;
  protectedValue?: ProtectedValueRef;
}>;

export class MemoryArtifactStore implements ArtifactStore {
  readonly capabilities: RuntimeCapabilities = MEMORY_STORE_CAPABILITIES;
  readonly securityProfile: StorageSecurityProfile;
  readonly #records = new Map<string, ArtifactRecord>();
  readonly #guard: MemoryStorageGuard;
  readonly #protector: DataProtector | undefined;
  readonly #maxInlineBytes: number;
  readonly #now: Now;

  constructor(options: ArtifactStoreOptions = {}) {
    this.securityProfile = options.securityProfile ?? createMemoryStorageSecurityProfile(options);
    this.#guard = new MemoryStorageGuard(this.securityProfile);
    this.#protector = options.dataProtector;
    this.#maxInlineBytes = options.maxInlineBytes ?? 256 * 1024;
    this.#now = options.now ?? systemNow;
    if (!Number.isSafeInteger(this.#maxInlineBytes) || this.#maxInlineBytes < 0) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "maxInlineBytes", issue: "nonnegative_integer" },
      });
    }
  }

  async put(input: Artifact, contentInput: Uint8Array): Promise<void> {
    const artifact = ArtifactSchema.parse(input);
    const content = new Uint8Array(contentInput);
    this.#guard.assertWriteAllowed(artifact.tenantId, artifact.purposeCode, artifact.dataClass);
    if (
      artifact.byteSize !== content.byteLength ||
      artifact.contentDigest !== digestBytes(content)
    ) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "artifact.content", issue: "digest_or_size_mismatch" },
      });
    }
    if (artifact.location.kind === "inline") {
      if (isSensitive(artifact.dataClass)) {
        throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
          details: { reason: "sensitive_artifact_must_use_protected_store_location" },
        });
      }
      if (digestBytes(decodeInlineContent(artifact.location)) !== artifact.contentDigest) {
        throw new KafError("KAF_SCHEMA_INVALID", {
          details: { path: "artifact.location.content", issue: "content_mismatch" },
        });
      }
    }
    if (artifact.location.kind === "inline" && content.byteLength > this.#maxInlineBytes) {
      throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
        details: { reason: "inline_artifact_too_large", maxInlineBytes: this.#maxInlineBytes },
      });
    }
    const key = recordKey(artifact.tenantId, artifact.artifactId);
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      const existingContent = await this.readContent(existing);
      if (
        sameJson(existing.artifact, artifact) &&
        digestBytes(existingContent) === digestBytes(content)
      ) {
        return;
      }
      conflict("artifact_changed");
    }
    if (isSensitive(artifact.dataClass)) {
      if (this.#protector === undefined) {
        throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
          details: { reason: "data_protector_required" },
        });
      }
      const protectedValue = await this.#protector.protect(artifactBinding(artifact), content);
      this.#records.set(key, { artifact: cloneJson(artifact), protectedValue });
      return;
    }
    this.#records.set(key, { artifact: cloneJson(artifact), content });
  }

  async get(
    tenantId: string,
    artifactId: string,
  ): Promise<{ artifact: Artifact; content: Uint8Array } | undefined> {
    const key = recordKey(tenantId, artifactId);
    const record = this.#records.get(key);
    if (record === undefined) return undefined;
    if (hasExpired(record.artifact.expiresAt, this.#now())) {
      this.#records.delete(key);
      return undefined;
    }
    const content = await this.readContent(record);
    if (record.artifact.contentDigest !== digestBytes(content))
      conflict("artifact_content_changed");
    return { artifact: cloneJson(record.artifact), content: new Uint8Array(content) };
  }

  async delete(tenantId: string, artifactId: string): Promise<void> {
    await Promise.resolve();
    this.#records.delete(recordKey(tenantId, artifactId));
  }

  purgeExpired(at = this.#now()): number {
    let removed = 0;
    for (const [key, record] of this.#records) {
      if (hasExpired(record.artifact.expiresAt, at)) {
        this.#records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private async readContent(record: ArtifactRecord): Promise<Uint8Array> {
    if (record.content !== undefined) return new Uint8Array(record.content);
    if (record.protectedValue === undefined || this.#protector === undefined) {
      throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
        details: { reason: "protected_artifact_unavailable" },
      });
    }
    return this.#protector.unprotect(artifactBinding(record.artifact), record.protectedValue);
  }
}

function isSensitive(dataClass: string): boolean {
  return dataClass === "confidential" || dataClass === "restricted";
}

function workOrderBinding(workOrder: AcceptedWorkOrder): Readonly<Record<string, string>> {
  return {
    tenantId: workOrder.tenant.id,
    workOrderId: workOrder.id,
    storeKind: "accepted_work_order",
    schemaVersion: workOrder.schemaVersion,
  };
}

function artifactBinding(artifact: Artifact): Readonly<Record<string, string>> {
  return {
    tenantId: artifact.tenantId,
    artifactId: artifact.artifactId,
    contentDigest: artifact.contentDigest,
    storeKind: "artifact",
    schemaVersion: artifact.schemaVersion,
  };
}

export function computeAcceptedWorkOrderBindingDigest(workOrder: AcceptedWorkOrder): Digest {
  const { workOrderBindingDigest, ...material } = workOrder;
  void workOrderBindingDigest;
  return digestCanonicalJson(material);
}

function decodeInlineContent(
  location: Extract<Artifact["location"], { kind: "inline" }>,
): Uint8Array {
  if (location.encoding === "utf8") return new TextEncoder().encode(location.content);
  try {
    const decoded = atob(location.content);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch (internalCause) {
    throw new KafError("KAF_SCHEMA_INVALID", {
      details: { path: "artifact.location.content", issue: "invalid_base64" },
      internalCause,
    });
  }
}

function assertWorkOrderBindingDigest(workOrder: AcceptedWorkOrder): void {
  if (computeAcceptedWorkOrderBindingDigest(workOrder) !== workOrder.workOrderBindingDigest) {
    conflict("work_order_binding_digest_mismatch");
  }
}
