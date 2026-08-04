import { digestBytes, digestCanonicalJson, type ProtectedValueRef } from "@pactmark/core";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  Aes256GcmDataProtector,
  MemoryProtectionNonceRegistry,
  POSTGRES_PROTECTED_STORAGE_SCHEMA_SQL,
  PostgresProtectionNonceRegistry,
  type DataProtectionKey,
  type DataProtectionKeyProvider,
  type PostgresClient,
  type PostgresDatabase,
  type SqlResult,
} from "../src/index.js";

const binding = Object.freeze({
  tenantId: "tenant-a",
  recordId: "record-1",
  storeKind: "context",
  schemaVersion: "1",
  purposeCode: "support",
  dataClass: "confidential",
  runId: "run-1",
  stepId: "step-1",
  sequence: "3",
  executionDefinitionDigest: digestBytes(new TextEncoder().encode("execution")),
  workOrderBindingDigest: digestBytes(new TextEncoder().encode("work-order")),
});

describe("AES-256-GCM data protection", () => {
  it("round-trips with full AAD and rejects wrong tenant, metadata, ciphertext, and key", async () => {
    const keys = new RotatingKeys(key("key-1", 1));
    const protector = new Aes256GcmDataProtector({
      keyProvider: keys,
      nonceRegistry: new MemoryProtectionNonceRegistry(),
      generateNonce: () => nonce(1),
    });
    const plaintext = new TextEncoder().encode("protected model context");
    const reference = await protector.protect(binding, plaintext);
    expect(reference.aadDigest).toBe(digestCanonicalJson(binding));
    expect(reference).toMatchObject({
      algorithm: "AES-256-GCM",
      protectorId: "pactmark.aes-256-gcm@1",
      keyId: "key-1",
    });
    await expect(protector.unprotect(binding, reference)).resolves.toEqual(plaintext);
    await expect(
      protector.unprotect({ ...binding, tenantId: "tenant-b" }, reference),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_SECURITY_PROFILE" });
    await expect(
      protector.unprotect({ ...binding, purposeCode: "analytics" }, reference),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_SECURITY_PROFILE" });
    await expect(
      protector.unprotect(binding, { ...reference, ciphertextDigest: digestBytes(nonce(9)) }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_SECURITY_PROFILE" });
    await expect(
      protector.unprotect(binding, tamperAuthenticationTag(reference)),
    ).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
    });
    keys.remove("key-1");
    await expect(protector.unprotect(binding, reference)).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
    });
  });

  it("retries a nonce collision, rotates new writes, and reads old-key ciphertext", async () => {
    const keys = new RotatingKeys(key("key-old", 2));
    const nonces = [nonce(7), nonce(7), nonce(8)];
    const protector = new Aes256GcmDataProtector({
      keyProvider: keys,
      nonceRegistry: new MemoryProtectionNonceRegistry(),
      generateNonce: () => nonces.shift() ?? nonce(9),
    });
    const first = await protector.protect(binding, new Uint8Array([1]));
    const second = await protector.protect(
      { ...binding, recordId: "record-2" },
      new Uint8Array([2]),
    );
    expect(first.ciphertextRef).not.toBe(second.ciphertextRef);
    keys.rotate(key("key-new", 3));
    const third = await protector.protect(
      { ...binding, recordId: "record-3" },
      new Uint8Array([3]),
    );
    expect(third.keyId).toBe("key-new");
    await expect(protector.unprotect(binding, first)).resolves.toEqual(new Uint8Array([1]));
  });

  it("fails before encryption when the per-key ceiling or nonce retries are exhausted", async () => {
    const keys = new RotatingKeys(key("key-1", 4));
    const ceilingProtector = new Aes256GcmDataProtector({
      keyProvider: keys,
      nonceRegistry: new MemoryProtectionNonceRegistry(),
      invocationCeiling: 1,
      generateNonce: (() => {
        let value = 0;
        return () => nonce(++value);
      })(),
    });
    await ceilingProtector.protect(binding, new Uint8Array([1]));
    await expect(
      ceilingProtector.protect({ ...binding, recordId: "record-2" }, new Uint8Array([2])),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_SECURITY_PROFILE" });

    const collisionRegistry = new MemoryProtectionNonceRegistry();
    await collisionRegistry.reserve({
      namespace: "collision",
      keyId: "key-1",
      nonce: nonce(1),
      invocationCeiling: 10,
    });
    const collisionProtector = new Aes256GcmDataProtector({
      keyProvider: keys,
      nonceRegistry: collisionRegistry,
      namespace: "collision",
      maxNonceAttempts: 2,
      generateNonce: () => nonce(1),
    });
    await expect(collisionProtector.protect(binding, new Uint8Array([1]))).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
    });
  });

  it("rejects non-96-bit nonces and non-256-bit keys", async () => {
    const badKeyProtector = new Aes256GcmDataProtector({
      keyProvider: new RotatingKeys({ keyId: "bad", key: new Uint8Array(31) }),
      nonceRegistry: new MemoryProtectionNonceRegistry(),
    });
    await expect(badKeyProtector.protect(binding, new Uint8Array())).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
    });
    const badNonceProtector = new Aes256GcmDataProtector({
      keyProvider: new RotatingKeys(key("good", 1)),
      nonceRegistry: new MemoryProtectionNonceRegistry(),
      generateNonce: () => new Uint8Array(11),
    });
    await expect(badNonceProtector.protect(binding, new Uint8Array())).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
    });
  });
});

describe("Postgres nonce registry", () => {
  it("reserves by namespace/key/96-bit nonce and enforces the durable counter ceiling", async () => {
    const database = new NonceDatabase();
    const registry = new PostgresProtectionNonceRegistry(database);
    await expect(
      registry.reserve({
        namespace: "protected",
        keyId: "key-1",
        nonce: nonce(1),
        invocationCeiling: 1,
      }),
    ).resolves.toBe("reserved");
    await expect(
      registry.reserve({
        namespace: "protected",
        keyId: "key-1",
        nonce: nonce(2),
        invocationCeiling: 1,
      }),
    ).resolves.toBe("ceiling_reached");
    await expect(
      registry.reserve({
        namespace: "another-namespace",
        keyId: "key-1",
        nonce: nonce(3),
        invocationCeiling: 1,
      }),
    ).resolves.toBe("ceiling_reached");
    expect(database.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("INSERT INTO pactmark_protection_key_counters"),
        expect.stringContaining("UPDATE pactmark_protection_key_counters"),
        expect.stringContaining("INSERT INTO pactmark_protection_nonces"),
      ]),
    );
    expect(POSTGRES_PROTECTED_STORAGE_SCHEMA_SQL).toContain("PRIMARY KEY (key_id,nonce)");
    expect(POSTGRES_PROTECTED_STORAGE_SCHEMA_SQL).toContain("octet_length(nonce) = 12");
  });
});

function key(keyId: string, fill: number): DataProtectionKey {
  return { keyId, key: new Uint8Array(32).fill(fill) };
}

function nonce(fill: number): Uint8Array {
  return new Uint8Array(12).fill(fill);
}

function tamperAuthenticationTag(reference: ProtectedValueRef): ProtectedValueRef {
  const prefix = "pactmark:aesgcm:v1:";
  const serialized = Buffer.from(reference.ciphertextRef.slice(prefix.length), "base64url");
  const envelope = JSON.parse(serialized.toString("utf8")) as {
    version: "1";
    nonce: string;
    ciphertext: string;
    tag: string;
  };
  const tampered = new TextEncoder().encode(
    JSON.stringify({
      ...envelope,
      tag: Buffer.from(new Uint8Array(16).fill(99)).toString("base64url"),
    }),
  );
  return {
    ...reference,
    ciphertextRef: `${prefix}${Buffer.from(tampered).toString("base64url")}`,
    ciphertextDigest: digestBytes(tampered),
  };
}

class RotatingKeys implements DataProtectionKeyProvider {
  readonly #keys = new Map<string, DataProtectionKey>();
  #current: DataProtectionKey;

  constructor(initial: DataProtectionKey) {
    this.#current = initial;
    this.#keys.set(initial.keyId, initial);
  }
  current(): Promise<DataProtectionKey> {
    return Promise.resolve(this.#current);
  }
  resolve(keyId: string): Promise<DataProtectionKey | undefined> {
    return Promise.resolve(this.#keys.get(keyId));
  }
  rotate(next: DataProtectionKey): void {
    this.#current = next;
    this.#keys.set(next.keyId, next);
  }
  remove(keyId: string): void {
    this.#keys.delete(keyId);
  }
}

class NonceDatabase implements PostgresDatabase, PostgresClient {
  readonly statements: string[] = [];
  readonly #counts = new Map<string, number>();
  readonly #ceilings = new Map<string, number>();
  readonly #namespaces = new Map<string, string>();

  connect(): Promise<PostgresClient> {
    return Promise.resolve(this);
  }
  release(): void {}
  query<Row extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    this.statements.push(text.replace(/\s+/gu, " ").trim());
    const namespace = String(values[0]);
    const counterKey = String(values[1]);
    if (text.includes("INSERT INTO pactmark_protection_key_counters")) {
      if (!this.#counts.has(counterKey)) {
        this.#counts.set(counterKey, 0);
        this.#ceilings.set(counterKey, Number(values[2]));
        this.#namespaces.set(counterKey, namespace);
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (text.includes("UPDATE pactmark_protection_key_counters")) {
      const count = this.#counts.get(counterKey) ?? 0;
      const ceiling = this.#ceilings.get(counterKey) ?? 0;
      if (
        this.#namespaces.get(counterKey) !== namespace ||
        ceiling !== Number(values[2]) ||
        count >= ceiling
      ) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      this.#counts.set(counterKey, count + 1);
      return Promise.resolve({
        rows: [{ invocation_count: count + 1 }] as unknown as Row[],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: text.startsWith("INSERT") ? 1 : 0 });
  }
}
