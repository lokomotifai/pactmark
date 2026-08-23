import { SecretRefSchema, type SecretRef } from "@pactmark/core";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type { PostgresClient, PostgresDatabase, SqlResult } from "../src/database.js";
import { PostgresSecretRefStore } from "../src/secret-ref-store.js";
import { digest, postgresSecurityProfile } from "./fixtures.js";

function secretRef(overrides: Partial<SecretRef> = {}): SecretRef {
  return SecretRefSchema.parse({
    schemaVersion: "1",
    credentialKind: "tool",
    refId: "secret-ref-1",
    issuerId: "issuer-1",
    tenantId: "tenant-a",
    authoritySubject: "user-1",
    workOrderBindingDigest: digest("work-order"),
    executionDefinitionKind: "agent",
    executionDefinitionDigest: digest("definition"),
    grantId: "grant-1",
    toolId: "publisher@1",
    toolVersion: "1.0.0",
    toolRegistrationDigest: digest("tool"),
    credentialSlot: "publisher.api-key",
    normalizedDestinationDigest: digest("destination"),
    effectDigest: digest("effect"),
    purpose: "service_delivery",
    maximumUses: 1,
    issuedAt: "2026-08-23T10:00:00.000Z",
    expiresAt: "2026-08-23T10:10:00.000Z",
    ...overrides,
  });
}

describe("PostgresSecretRefStore", () => {
  it("round-trips immutable opaque metadata through tenant-bound transactions", async () => {
    const database = new SecretRefDatabase();
    const store = new PostgresSecretRefStore(database, postgresSecurityProfile());
    const ref = secretRef();

    await expect(
      store.putImmutable({
        ...ref,
        resolvedValue: "resolved-secret-canary",
      } as unknown as SecretRef),
    ).rejects.toBeDefined();
    await store.putImmutable(ref);
    await expect(store.get(ref.tenantId, ref.refId)).resolves.toEqual(ref);
    await expect(store.get("tenant-b", ref.refId)).resolves.toBeUndefined();
    await expect(store.putImmutable(ref)).resolves.toBeUndefined();
    await expect(store.putImmutable(secretRef({ grantId: "grant-2" }))).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });

    expect(JSON.stringify(database.row)).not.toContain("resolved-secret-canary");
    expect(database.statements.filter((text) => text.includes("set_config"))).toHaveLength(5);
  });

  it("revokes once, replays exactly, and rejects a changed revocation", async () => {
    const database = new SecretRefDatabase();
    const store = new PostgresSecretRefStore(database, postgresSecurityProfile());
    const ref = secretRef();
    const revokedAt = "2026-08-23T10:01:00.000Z";

    await store.putImmutable(ref);
    await store.revoke(ref.tenantId, ref.refId, revokedAt);
    await store.revoke(ref.tenantId, ref.refId, revokedAt);
    await expect(store.get(ref.tenantId, ref.refId)).resolves.toMatchObject({ revokedAt });
    await expect(
      store.revoke(ref.tenantId, ref.refId, "2026-08-23T10:02:00.000Z"),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(store.revoke(ref.tenantId, "missing", revokedAt)).rejects.toMatchObject({
      code: "KAF_STORAGE_NOT_FOUND",
    });
  });

  it("re-checks the stored purpose before read or revocation", async () => {
    const database = new SecretRefDatabase();
    await new PostgresSecretRefStore(database, postgresSecurityProfile()).putImmutable(secretRef());
    const restricted = new PostgresSecretRefStore(
      database,
      postgresSecurityProfile({ allowedPurposes: ["support"] }),
    );

    await expect(restricted.get("tenant-a", "secret-ref-1")).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
      details: { reason: "purpose" },
    });
    await expect(
      restricted.revoke("tenant-a", "secret-ref-1", "2026-08-23T10:01:00.000Z"),
    ).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
      details: { reason: "purpose" },
    });
  });
});

class SecretRefDatabase implements PostgresDatabase {
  readonly tenantTransactions = true;
  row:
    | {
        tenantId: string;
        refId: string;
        binding_digest: string;
        metadata_json: unknown;
        revoked_at: string | Date | null;
      }
    | undefined;
  readonly statements: string[] = [];

  async query<Row extends QueryResultRow>(): Promise<SqlResult<Row>> {
    await Promise.resolve();
    throw new Error("tenant-scoped store bypassed its transaction boundary");
  }

  async connect(): Promise<PostgresClient> {
    await Promise.resolve();
    return {
      query: <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) =>
        this.#query<Row>(text, values),
      release: () => undefined,
    };
  }

  async #query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    await Promise.resolve();
    this.statements.push(text);
    if (
      text === "BEGIN" ||
      text === "COMMIT" ||
      text === "ROLLBACK" ||
      text.includes("set_config")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("SELECT binding_digest")) {
      const row = this.row;
      const [tenantId, refId] = values ?? [];
      const matches = row !== undefined && row.tenantId === tenantId && row.refId === refId;
      return {
        rows: (matches
          ? [
              {
                binding_digest: row.binding_digest,
                metadata_json: row.metadata_json,
                revoked_at: row.revoked_at,
              },
            ]
          : []) as unknown as Row[],
        rowCount: matches ? 1 : 0,
      };
    }
    if (text.includes("INSERT INTO pactmark_secret_refs")) {
      this.row = {
        tenantId: String(values?.[0]),
        refId: String(values?.[1]),
        binding_digest: String(values?.[2]),
        revoked_at: values?.[3] as string | null,
        metadata_json: values?.[4],
      };
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("UPDATE pactmark_secret_refs")) {
      if (this.row === undefined) return { rows: [], rowCount: 0 };
      this.row = {
        ...this.row,
        binding_digest: String(values?.[2]),
        revoked_at: values?.[3] as string,
        metadata_json: values?.[4],
      };
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }
}
