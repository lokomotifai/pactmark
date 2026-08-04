import { digestCanonicalJson } from "@pactmark/core";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createPostgresStorageSecurityProfile } from "../src/config.js";
import type { PostgresClient, PostgresDatabase, SqlResult } from "../src/database.js";
import {
  PostgresEvidenceRecordStore,
  PostgresPatternRecordStore,
  PostgresVerificationRecordStore,
} from "../src/evidence-record-stores.js";
import { evidenceRecord, patternRecord, verificationRecord } from "./fixtures.js";

describe("durable immutable evidence record stores", () => {
  it("round-trips exact records after store reconstruction and isolates tenant routes", async () => {
    const database = new EvidenceRecordDatabase();
    const profile = createPostgresStorageSecurityProfile();
    const first = stores(database, profile);
    const evidence = evidenceRecord();
    const verification = verificationRecord();
    const pattern = patternRecord();
    await first.evidence.putImmutable(evidence);
    await first.evidence.putImmutable(evidence);
    await first.verification.putImmutable(verification);
    await first.verification.putImmutable(verification);
    await first.pattern.putImmutable(pattern);
    await first.pattern.putImmutable(pattern);

    const reloaded = stores(database, profile);
    await expect(reloaded.evidence.get("tenant-a", "evidence-1")).resolves.toEqual(evidence);
    await expect(
      reloaded.evidence.getByDigest("tenant-a", evidence.evidenceDigest),
    ).resolves.toEqual(evidence);
    await expect(reloaded.verification.get("tenant-a", "run-1", "verification-1")).resolves.toEqual(
      verification,
    );
    await expect(
      reloaded.verification.getByDigest("tenant-a", verification.verification.verificationDigest),
    ).resolves.toEqual(verification);
    await expect(reloaded.pattern.get("tenant-a", "pattern-1", "1")).resolves.toEqual(pattern);
    await expect(
      reloaded.pattern.getByDigest("tenant-a", pattern.pattern.patternDigest),
    ).resolves.toEqual(pattern);
    await expect(reloaded.evidence.get("tenant-b", "evidence-1")).resolves.toBeUndefined();
    await expect(
      reloaded.verification.getByDigest("tenant-b", verification.verification.verificationDigest),
    ).resolves.toBeUndefined();
    await expect(reloaded.pattern.get("tenant-b", "pattern-1", "1")).resolves.toBeUndefined();
    expect(database.queries.every(({ values }) => values?.[0] !== undefined)).toBe(true);
  });

  it("rejects digest tampering, immutable-key changes, and digest reuse across routes", async () => {
    const database = new EvidenceRecordDatabase();
    const profile = createPostgresStorageSecurityProfile();
    const store = stores(database, profile);
    const evidence = evidenceRecord();
    const verification = verificationRecord();
    const pattern = patternRecord();
    await store.evidence.putImmutable(evidence);
    await store.verification.putImmutable(verification);
    await store.pattern.putImmutable(pattern);

    await expect(
      store.evidence.putImmutable({ ...evidence, supports: ["tampered"] }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      store.verification.putImmutable({ ...verification, runId: "run-2" }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    const { patternDigest: _oldDigest, ...changedPatternMaterial } = pattern.pattern;
    void _oldDigest;
    const changedPattern = { ...changedPatternMaterial, title: "Changed title" };
    await expect(
      store.pattern.putImmutable({
        ...pattern,
        pattern: { ...changedPattern, patternDigest: digestCanonicalJson(changedPattern) },
      }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
  });

  it("rejects database rows whose tenant, route, digest, or canonical identity changed", async () => {
    const database = new EvidenceRecordDatabase();
    const store = stores(database, createPostgresStorageSecurityProfile());
    const evidence = evidenceRecord();
    const verification = verificationRecord();
    const pattern = patternRecord();

    database.returnNext(evidenceRecord("tenant-b"));
    await expect(store.evidence.get("tenant-a", "evidence-1")).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    database.returnNext({ ...verification, runId: "other-run" });
    await expect(
      store.verification.get("tenant-a", "run-1", "verification-1"),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    database.returnNext({
      ...pattern,
      pattern: { ...pattern.pattern, version: "other-version" },
    });
    await expect(store.pattern.get("tenant-a", "pattern-1", "1")).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });

    for (const [record, lookup] of [
      [evidence, () => store.evidence.getByDigest("tenant-a", digestCanonicalJson("wrong"))],
      [
        verification,
        () => store.verification.getByDigest("tenant-a", digestCanonicalJson("wrong")),
      ],
      [pattern, () => store.pattern.getByDigest("tenant-a", digestCanonicalJson("wrong"))],
    ] as const) {
      database.returnNext(record);
      await expect(lookup()).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    }

    for (const [record, lookup] of [
      [evidence, () => store.evidence.get("tenant-a", "evidence-1")],
      [verification, () => store.verification.get("tenant-a", "run-1", "verification-1")],
      [pattern, () => store.pattern.get("tenant-a", "pattern-1", "1")],
    ] as const) {
      database.returnNext(record, digestCanonicalJson("changed-row"));
      await expect(lookup()).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    }
  });
});

function stores(
  database: PostgresDatabase,
  profile: ReturnType<typeof createPostgresStorageSecurityProfile>,
) {
  return {
    evidence: new PostgresEvidenceRecordStore(database, profile),
    verification: new PostgresVerificationRecordStore(database, profile),
    pattern: new PostgresPatternRecordStore(database, profile),
  };
}

type StoredRow = {
  canonical_digest: string;
  record_json: unknown;
};

class EvidenceRecordDatabase implements PostgresDatabase {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly #routes = new Map<string, StoredRow>();
  readonly #digests = new Map<string, string>();
  #nextRow: StoredRow | undefined;

  returnNext(record: unknown, canonicalDigest = digestCanonicalJson(record)): void {
    this.#nextRow = { canonical_digest: canonicalDigest, record_json: JSON.stringify(record) };
  }

  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    this.queries.push({ text, ...(values === undefined ? {} : { values }) });
    const table = tableName(text);
    if (text.includes("INSERT INTO")) {
      const tenantId = String(values?.[0]);
      const digest = String(values?.[3]);
      const route = routeKey(table, values ?? []);
      const digestRoute = `${table}\u0000${tenantId}\u0000${digest}`;
      if (this.#routes.has(route) || this.#digests.has(digestRoute)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      this.#routes.set(route, {
        canonical_digest: String(values?.[4]),
        record_json: String(values?.[5]),
      });
      this.#digests.set(digestRoute, route);
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (this.#nextRow !== undefined) {
      const row = this.#nextRow;
      this.#nextRow = undefined;
      return Promise.resolve({ rows: [row] as unknown as Row[], rowCount: 1 });
    }
    const digestLookup = /(?:evidence|verification|pattern)_digest=\$2/u.test(text);
    const route = digestLookup
      ? this.#digests.get(`${table}\u0000${String(values?.[0])}\u0000${String(values?.[1])}`)
      : routeKey(table, values ?? []);
    const row = route === undefined ? undefined : this.#routes.get(route);
    return Promise.resolve({
      rows: (row === undefined ? [] : [row]) as unknown as Row[],
      rowCount: row === undefined ? 0 : 1,
    });
  }

  connect(): Promise<PostgresClient> {
    throw new Error("Transactions are not used by immutable record stores");
  }
}

function tableName(sql: string): string {
  const match = /pactmark_(evidence|verification|pattern)_records/u.exec(sql);
  if (match?.[1] === undefined) throw new Error("Unexpected evidence record SQL");
  return match[1];
}

function routeKey(table: string, values: readonly unknown[]): string {
  const length = table === "evidence" ? 2 : 3;
  return `${table}\u0000${values.slice(0, length).map(String).join("\u0000")}`;
}
