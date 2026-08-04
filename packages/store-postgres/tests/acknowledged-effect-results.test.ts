import {
  KafError,
  digestBytes,
  digestCanonicalJson,
  type DataProtector,
  type ProtectedValueRef,
} from "@pactmark/core";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { PostgresAcknowledgedEffectResultStore } from "../src/acknowledged-effect-results.js";
import { createPostgresStorageSecurityProfile } from "../src/config.js";
import type { PostgresClient, PostgresDatabase, SqlResult } from "../src/database.js";
import { acknowledgedEffect, acknowledgedEffectResult, protectedEffectResult } from "./fixtures.js";

describe("durable protected acknowledged effect results", () => {
  it("reloads through a fresh store, hides cross-tenant rows, and accepts fresh ciphertext replay", async () => {
    const database = new EffectResultDatabase();
    const protector = new TestProtector();
    const effect = acknowledgedEffect();
    const first = await protectedEffectResult(protector, effect);
    const replay = await protectedEffectResult(protector, effect);
    const store = new PostgresAcknowledgedEffectResultStore(database, profile(), protector);
    await store.putImmutable(first);
    await store.putImmutable(replay);
    const fresh = new PostgresAcknowledgedEffectResultStore(database, profile(), protector);
    await expect(fresh.getAcknowledgedResult(effect)).resolves.toEqual(acknowledgedEffectResult);
    await expect(
      fresh.getAcknowledgedResult(acknowledgedEffect({ tenantId: "tenant-b" })),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(database.queries)).not.toContain("PLAINTEXT-EFFECT-RESULT-CANARY");
  });

  it("scopes protected-reference uniqueness by tenant and rejects same-tenant reuse", async () => {
    const database = new EffectResultDatabase();
    const protector = new TestProtector();
    const store = new PostgresAcknowledgedEffectResultStore(database, profile(), protector);
    const tenantA = await protectedEffectResult(protector);
    const tenantBEffect = acknowledgedEffect({ tenantId: "tenant-b" });
    const tenantB = await protectedEffectResult(protector, tenantBEffect);
    await store.putImmutable(tenantA);
    await expect(
      store.putImmutable({ ...tenantB, protectedValue: tenantA.protectedValue }),
    ).resolves.toBeUndefined();
    await expect(store.getAcknowledgedResult(acknowledgedEffect())).resolves.toEqual(
      acknowledgedEffectResult,
    );

    const secondEffect = acknowledgedEffect({ effectId: "effect-2" });
    const second = await protectedEffectResult(protector, secondEffect);
    await expect(
      store.putImmutable({ ...second, protectedValue: tenantA.protectedValue }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
  });

  it("detects row, AAD, result digest, byte size, and schema tampering", async () => {
    const database = new EffectResultDatabase();
    const protector = new TestProtector();
    const effect = acknowledgedEffect();
    const record = await protectedEffectResult(protector, effect);
    const store = new PostgresAcknowledgedEffectResultStore(database, profile(), protector);
    await store.putImmutable(record);

    database.tamperNext((row) => ({ ...row, result_digest: digestBytes(new Uint8Array([1])) }));
    await expect(store.getAcknowledgedResult(effect)).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    database.tamperNext((row) => ({ ...row, canonical_digest: digestBytes(new Uint8Array([2])) }));
    await expect(store.getAcknowledgedResult(effect)).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    database.tamperNext((row) => ({ ...row, byte_size: Number(row.byte_size) + 1 }));
    await expect(store.getAcknowledgedResult(effect)).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    database.tamperNext((row) => ({ ...row, record_json: JSON.stringify({ schemaVersion: "2" }) }));
    await expect(store.getAcknowledgedResult(effect)).rejects.toThrow();

    const aadDatabase = new EffectResultDatabase();
    const aadStore = new PostgresAcknowledgedEffectResultStore(aadDatabase, profile(), protector);
    await aadStore.putImmutable({ ...record, purposeCode: "other" });
    await expect(aadStore.getAcknowledgedResult(effect)).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
    });
  });
});

function profile() {
  return createPostgresStorageSecurityProfile({
    allowedTenants: ["tenant-a", "tenant-b"],
    allowedPurposes: ["support", "other"],
  });
}

type EffectResultRow = Record<string, unknown> & {
  tenant_id: string;
  run_id: string;
  effect_id: string;
  effect_digest: string;
  protected_key_id: string;
  protected_ref: string;
};

class EffectResultDatabase implements PostgresDatabase {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly #rows = new Map<string, EffectResultRow>();
  #tamper: ((row: EffectResultRow) => EffectResultRow) | undefined;

  tamperNext(operation: (row: EffectResultRow) => EffectResultRow): void {
    this.#tamper = operation;
  }

  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    this.queries.push({ text, ...(values === undefined ? {} : { values }) });
    if (text.includes("INSERT INTO pactmark_acknowledged_effect_results")) {
      const row = rowFromInsert(values ?? []);
      const route = routeKey(row.tenant_id, row.run_id, row.effect_id);
      const collides =
        this.#rows.has(route) ||
        [...this.#rows.values()].some(
          (existing) =>
            (existing.tenant_id === row.tenant_id &&
              existing.effect_digest === row.effect_digest) ||
            (existing.tenant_id === row.tenant_id &&
              existing.protected_key_id === row.protected_key_id &&
              existing.protected_ref === row.protected_ref),
        );
      if (collides) return Promise.resolve({ rows: [], rowCount: 0 });
      this.#rows.set(route, row);
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    const tenantId = String(values?.[0]);
    const runId = String(values?.[1]);
    const effectId = String(values?.[2]);
    let rows: EffectResultRow[];
    if (text.includes(" OR effect_digest=$4")) {
      const digest = String(values?.[3]);
      rows = [...this.#rows.values()].filter(
        (row) =>
          row.tenant_id === tenantId &&
          ((row.run_id === runId && row.effect_id === effectId) || row.effect_digest === digest),
      );
    } else {
      const row = this.#rows.get(routeKey(tenantId, runId, effectId));
      rows = row === undefined ? [] : [row];
    }
    if (rows[0] !== undefined && this.#tamper !== undefined) {
      rows[0] = this.#tamper(rows[0]);
      this.#tamper = undefined;
    }
    return Promise.resolve({ rows: rows as unknown as Row[], rowCount: rows.length });
  }

  connect(): Promise<PostgresClient> {
    throw new Error("not used");
  }
}

function routeKey(tenantId: string, runId: string, effectId: string): string {
  return `${tenantId}\u0000${runId}\u0000${effectId}`;
}

function rowFromInsert(values: readonly unknown[]): EffectResultRow {
  return {
    tenant_id: String(values[0]),
    run_id: String(values[1]),
    effect_id: String(values[2]),
    effect_digest: String(values[3]),
    result_digest: String(values[4]),
    byte_size: Number(values[5]),
    work_order_id: String(values[6]),
    work_order_binding_digest: String(values[7]),
    execution_definition_digest: String(values[8]),
    tool_id: String(values[9]),
    tool_version: String(values[10]),
    tool_registration_digest: String(values[11]),
    strategy: String(values[12]),
    strategy_registration_digest: String(values[13]),
    result_schema_digest: String(values[14]),
    purpose_code: String(values[15]),
    purpose_registry_version: String(values[16]),
    data_class: String(values[17]),
    canonical_digest: String(values[18]),
    record_json: String(values[19]),
    protected_key_id: String(values[20]),
    protected_ref: String(values[21]),
  };
}

class TestProtector implements DataProtector {
  readonly #values = new Map<string, Uint8Array>();
  #counter = 0;

  async protect(
    binding: Readonly<Record<string, string>>,
    plaintext: Uint8Array,
  ): Promise<ProtectedValueRef> {
    await Promise.resolve();
    this.#counter += 1;
    const ciphertextRef = `ciphertext-${String(this.#counter)}`;
    this.#values.set(ciphertextRef, new Uint8Array(plaintext));
    return {
      schemaVersion: "1",
      protectorId: "test",
      keyId: "key-1",
      ciphertextRef,
      ciphertextDigest: digestBytes(plaintext),
      aadDigest: digestCanonicalJson(binding),
      algorithm: "test-only",
    };
  }

  async unprotect(
    binding: Readonly<Record<string, string>>,
    reference: ProtectedValueRef,
  ): Promise<Uint8Array> {
    await Promise.resolve();
    if (reference.aadDigest !== digestCanonicalJson(binding)) {
      throw new KafError("KAF_STORAGE_SECURITY_PROFILE", { details: { reason: "aad_mismatch" } });
    }
    const value = this.#values.get(reference.ciphertextRef);
    if (value === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    return new Uint8Array(value);
  }
}
