import {
  digestBytes,
  digestCanonicalJson,
  type DataProtector,
  type ProtectedValueRef,
} from "@pactmark/core";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { Aes256GcmDataProtector, MemoryProtectionNonceRegistry } from "../src/data-protector.js";
import type { PostgresClient, PostgresDatabase, SqlResult } from "../src/database.js";
import {
  PostgresArtifactStore,
  PostgresContextStore,
  PostgresInputSubmissionStore,
} from "../src/record-stores.js";
import {
  artifact,
  contextSnapshot,
  inputSubmission,
  postgresSecurityProfile as createPostgresStorageSecurityProfile,
} from "./fixtures.js";

describe("protected record stores", () => {
  it("stores typed input once, rejects changed replay, and isolates tenant reads", async () => {
    const database = new RecordDatabase();
    const store = new PostgresInputSubmissionStore(
      database,
      createPostgresStorageSecurityProfile(),
      { dataProtector: requiredProtector },
    );
    const input = inputSubmission();
    await expect(store.putOnce(input)).resolves.toEqual(input);
    await expect(store.putOnce(input)).resolves.toEqual(input);
    await expect(
      store.putOnce({ ...input, valueDigest: input.inputSchemaDigest }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(store.get("tenant-b", input.runId, input.requestId)).resolves.toBeUndefined();
    await store.delete(input.tenantId, input.runId, input.requestId);
    await expect(store.get(input.tenantId, input.runId, input.requestId)).resolves.toBeUndefined();
  });

  it("returns the highest tenant/run context snapshot and deletes only that stream", async () => {
    const database = new RecordDatabase();
    const store = new PostgresContextStore(database, createPostgresStorageSecurityProfile(), {
      dataProtector: requiredProtector,
    });
    await store.put(contextSnapshot("snapshot-1", 1));
    await store.put(contextSnapshot("snapshot-2", 2));
    await expect(store.getLatest("tenant-a", "run-1")).resolves.toMatchObject({
      snapshotId: "snapshot-2",
      sequence: 2,
    });
    await expect(store.getLatest("tenant-b", "run-1")).resolves.toBeUndefined();
    await store.delete("tenant-a", "run-1");
    await expect(store.getLatest("tenant-a", "run-1")).resolves.toBeUndefined();
  });

  it("protects and validates operational context separately from event storage", async () => {
    const database = new RecordDatabase();
    const protector = new Aes256GcmDataProtector({
      keyProvider: {
        current: () => Promise.resolve({ keyId: "context-key", key: new Uint8Array(32).fill(7) }),
        resolve: () => Promise.resolve({ keyId: "context-key", key: new Uint8Array(32).fill(7) }),
      },
      nonceRegistry: new MemoryProtectionNonceRegistry(),
      generateNonce: () => new Uint8Array(12).fill(5),
    });
    const store = new PostgresContextStore(database, createPostgresStorageSecurityProfile(), {
      dataProtector: protector,
    });
    const plaintext = new TextEncoder().encode("durable context body");
    const { protectedValue: _protectedValue, ...metadata } = contextSnapshot();
    void _protectedValue;
    const protectedSnapshot = await store.putProtected(
      {
        ...metadata,
        contextDigest: digestBytes(plaintext),
        byteSize: plaintext.byteLength,
      },
      plaintext,
    );
    expect(JSON.stringify(protectedSnapshot)).not.toContain("durable context body");
    await expect(store.getLatestProtected("tenant-a", "run-1")).resolves.toMatchObject({
      plaintext,
    });
    await expect(store.getLatestProtected("tenant-b", "run-1")).resolves.toBeUndefined();
  });

  it("validates artifact bytes, enforces the configured inline limit, and returns byte copies", async () => {
    const database = new RecordDatabase();
    const store = new PostgresArtifactStore(database, createPostgresStorageSecurityProfile(), {
      maxInlineArtifactBytes: 4,
    });
    const content = new TextEncoder().encode("data");
    const metadata = artifact(content);
    await store.put(metadata, content);
    const stored = await store.get("tenant-a", metadata.artifactId);
    expect(new TextDecoder().decode(stored?.content)).toBe("data");
    if (stored !== undefined) stored.content[0] = 0;
    expect(
      new TextDecoder().decode((await store.get("tenant-a", metadata.artifactId))?.content),
    ).toBe("data");
    await expect(store.get("tenant-b", metadata.artifactId)).resolves.toBeUndefined();
    const large = new TextEncoder().encode("large");
    await expect(store.put(artifact(large), large)).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
    });
    await store.delete("tenant-a", metadata.artifactId);
    await expect(store.get("tenant-a", metadata.artifactId)).resolves.toBeUndefined();
  });

  it("protects confidential artifact bodies and rejects them without a protector before SQL", async () => {
    const content = new TextEncoder().encode("confidential body");
    const metadata = {
      ...artifact(content),
      dataClass: "confidential" as const,
      location: { kind: "store" as const, storeId: "postgres", objectRef: "artifact-1" },
    };
    const rejectedDatabase = new RecordDatabase();
    const unprotectedStore = new PostgresArtifactStore(
      rejectedDatabase,
      createPostgresStorageSecurityProfile(),
    );
    await expect(unprotectedStore.put(metadata, content)).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
    });
    expect(rejectedDatabase.statements.some((text) => text.includes("INSERT INTO"))).toBe(false);

    const database = new RecordDatabase();
    const protector = new RoundTripProtector();
    const store = new PostgresArtifactStore(database, createPostgresStorageSecurityProfile(), {
      dataProtector: protector,
    });
    await store.put(metadata, content);
    expect(database.artifactPlaintextWasStored).toBe(false);
    await expect(store.get("tenant-a", "artifact-1")).resolves.toMatchObject({ content });
  });

  it("exposes deterministic expiry deletion hooks for context and artifacts", async () => {
    const database = new RetentionDatabase();
    const deletions: unknown[] = [];
    const options = {
      dataProtector: requiredProtector,
      now: () => "2026-08-05T00:00:00.000Z",
      onDelete: (record: unknown) => {
        deletions.push(record);
      },
    };
    const profile = createPostgresStorageSecurityProfile();
    const contextStore = new PostgresContextStore(database, profile, options);
    const artifactStore = new PostgresArtifactStore(database, profile, options);
    await expect(contextStore.purgeExpired()).resolves.toBe(1);
    await expect(artifactStore.purgeExpired()).resolves.toBe(1);
    expect(database.values).toEqual([["2026-08-05T00:00:00.000Z"], ["2026-08-05T00:00:00.000Z"]]);
    expect(deletions).toEqual([
      {
        tenantId: "tenant-a",
        storeKind: "context",
        recordId: "snapshot-expired",
        reason: "expired",
      },
      {
        tenantId: "tenant-a",
        storeKind: "artifact",
        recordId: "artifact-expired",
        reason: "expired",
      },
    ]);
  });
});

const requiredProtector: DataProtector = {
  protect: (binding, plaintext) =>
    Promise.resolve({
      schemaVersion: "1",
      protectorId: "test",
      keyId: "test-key",
      ciphertextRef: "test-ref",
      ciphertextDigest: digestBytes(plaintext),
      aadDigest: digestCanonicalJson(binding),
      algorithm: "test-only",
    }),
  unprotect: () => Promise.reject(new Error("not used")),
};

type JsonRow = { canonical_digest: string; record_json: unknown };
type ArtifactRow = {
  canonical_digest: string;
  artifact_json: unknown;
  content: Uint8Array | null;
  protected_ref_json: unknown;
};

class RecordDatabase implements PostgresDatabase {
  readonly statements: string[] = [];
  artifactPlaintextWasStored = false;
  readonly #inputs = new Map<string, JsonRow>();
  readonly #contexts = new Map<string, JsonRow & { sequence: number; snapshot_id: string }>();
  readonly #artifacts = new Map<string, ArtifactRow>();

  async query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    await Promise.resolve();
    this.statements.push(text);
    const tenantId = String(values?.[0]);
    if (text.includes("INSERT INTO pactmark_input_submissions")) {
      const storageKey = key(tenantId, String(values?.[1]), String(values?.[2]));
      if (this.#inputs.has(storageKey)) return empty();
      this.#inputs.set(storageKey, {
        canonical_digest: String(values?.[6]),
        record_json: JSON.parse(String(values?.[11])),
      });
      return one();
    }
    if (text.startsWith("SELECT") && text.includes("FROM pactmark_input_submissions")) {
      const row = this.#inputs.get(key(tenantId, String(values?.[1]), String(values?.[2])));
      return rows(row === undefined ? [] : [row]);
    }
    if (text.includes("DELETE FROM pactmark_input_submissions")) {
      const deleted = this.#inputs.delete(key(tenantId, String(values?.[1]), String(values?.[2])));
      return count(deleted);
    }
    if (text.includes("INSERT INTO pactmark_context_snapshots")) {
      const storageKey = key(tenantId, String(values?.[1]), String(values?.[2]));
      if (this.#contexts.has(storageKey)) return empty();
      this.#contexts.set(storageKey, {
        canonical_digest: String(values?.[4]),
        record_json: JSON.parse(String(values?.[8])),
        sequence: Number(values?.[3]),
        snapshot_id: String(values?.[2]),
      });
      return one();
    }
    if (text.startsWith("SELECT") && text.includes("FROM pactmark_context_snapshots")) {
      const runId = String(values?.[1]);
      const candidates = [...this.#contexts.entries()]
        .filter(([storageKey]) => storageKey.startsWith(key(tenantId, runId)))
        .map(([, row]) => row)
        .toSorted((left, right) =>
          right.sequence === left.sequence
            ? right.snapshot_id.localeCompare(left.snapshot_id)
            : right.sequence - left.sequence,
        );
      return rows(candidates.slice(0, 1));
    }
    if (text.includes("DELETE FROM pactmark_context_snapshots")) {
      const prefix = key(tenantId, String(values?.[1]));
      let deleted = false;
      for (const storageKey of this.#contexts.keys()) {
        if (storageKey.startsWith(prefix)) deleted = this.#contexts.delete(storageKey) || deleted;
      }
      return count(deleted);
    }
    if (text.includes("INSERT INTO pactmark_artifacts")) {
      const storageKey = key(tenantId, String(values?.[1]));
      if (this.#artifacts.has(storageKey)) return empty();
      this.#artifacts.set(storageKey, {
        canonical_digest: String(values?.[2]),
        artifact_json: JSON.parse(String(values?.[7])),
        content: values?.[8] as Uint8Array,
        protected_ref_json: values?.[9] ?? null,
      });
      this.artifactPlaintextWasStored = values?.[8] !== null;
      return one();
    }
    if (text.startsWith("SELECT") && text.includes("FROM pactmark_artifacts")) {
      const row = this.#artifacts.get(key(tenantId, String(values?.[1])));
      return rows(row === undefined ? [] : [row]);
    }
    if (text.includes("DELETE FROM pactmark_artifacts")) {
      return count(this.#artifacts.delete(key(tenantId, String(values?.[1]))));
    }
    return empty();

    function rows(valuesToReturn: readonly unknown[]): SqlResult<Row> {
      return { rows: valuesToReturn as Row[], rowCount: valuesToReturn.length };
    }
    function empty(): SqlResult<Row> {
      return { rows: [], rowCount: 0 };
    }
    function one(): SqlResult<Row> {
      return { rows: [], rowCount: 1 };
    }
    function count(present: boolean): SqlResult<Row> {
      return { rows: [], rowCount: present ? 1 : 0 };
    }
  }

  async connect(): Promise<PostgresClient> {
    await Promise.resolve();
    throw new Error("not used by this test");
  }
}

class RoundTripProtector implements DataProtector {
  readonly #values = new Map<string, Uint8Array>();
  #sequence = 0;

  protect(
    binding: Readonly<Record<string, string>>,
    plaintext: Uint8Array,
  ): Promise<ProtectedValueRef> {
    const ciphertextRef = `roundtrip-${String(++this.#sequence)}`;
    this.#values.set(ciphertextRef, new Uint8Array(plaintext));
    return Promise.resolve({
      schemaVersion: "1",
      protectorId: "roundtrip",
      keyId: "key-1",
      ciphertextRef,
      ciphertextDigest: digestBytes(plaintext),
      aadDigest: digestCanonicalJson(binding),
      algorithm: "test-only",
    });
  }

  unprotect(
    _binding: Readonly<Record<string, string>>,
    reference: ProtectedValueRef,
  ): Promise<Uint8Array> {
    const value = this.#values.get(reference.ciphertextRef);
    if (value === undefined) return Promise.reject(new Error("missing protected fixture"));
    return Promise.resolve(new Uint8Array(value));
  }
}

class RetentionDatabase implements PostgresDatabase {
  readonly values: unknown[][] = [];

  query<Row extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    this.values.push([...values]);
    if (text.includes("pactmark_context_snapshots")) {
      return Promise.resolve({
        rows: [{ tenant_id: "tenant-a", snapshot_id: "snapshot-expired" }] as unknown as Row[],
        rowCount: 1,
      });
    }
    return Promise.resolve({
      rows: [{ tenant_id: "tenant-a", artifact_id: "artifact-expired" }] as unknown as Row[],
      rowCount: 1,
    });
  }

  connect(): Promise<PostgresClient> {
    return Promise.reject(new Error("not used"));
  }
}

function key(...parts: readonly string[]): string {
  return `${parts.join("\u0000")}\u0000`;
}
