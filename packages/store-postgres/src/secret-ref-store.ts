import {
  KafError,
  SecretRefSchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  type SecretRef,
  type SecretRefStore,
  type StorageSecurityProfile,
} from "@pactmark/core";

import { PostgresStorageGuard } from "./config.js";
import type { PostgresClient, PostgresDatabase } from "./database.js";
import { queryForTenant, withTenantTransaction } from "./database.js";
import { assertNonempty, conflict, parseJsonColumn } from "./internal.js";

type SecretRefRow = {
  binding_digest: string;
  metadata_json: unknown;
  revoked_at: string | Date | null;
};

/** Durable opaque SecretRef metadata. Resolved credential values never cross this boundary. */
export class PostgresSecretRefStore implements SecretRefStore {
  readonly #guard: PostgresStorageGuard;

  constructor(
    readonly database: PostgresDatabase,
    securityProfile: StorageSecurityProfile,
  ) {
    this.#guard = new PostgresStorageGuard(securityProfile);
  }

  async putImmutable(input: SecretRef): Promise<void> {
    const ref = SecretRefSchema.parse(input);
    this.#guard.assertTenantAllowed(ref.tenantId);
    this.#guard.assertPurposeAllowed(ref.purpose);
    await withTenantTransaction(this.database, ref.tenantId, async (client) => {
      const existing = await findRef(client, ref.tenantId, ref.refId, true);
      if (existing !== undefined) {
        assertStoredRef(existing, ref.tenantId, ref.refId, ref);
        return;
      }
      await client.query(
        `INSERT INTO pactmark_secret_refs
         (tenant_id,secret_ref_id,binding_digest,revoked_at,metadata_json)
         VALUES ($1,$2,$3,$4::timestamptz,$5::jsonb)`,
        [
          ref.tenantId,
          ref.refId,
          digestCanonicalJson(ref),
          ref.revokedAt ?? null,
          JSON.stringify(ref),
        ],
      );
    });
  }

  async get(tenantId: string, refId: string): Promise<SecretRef | undefined> {
    validateRoute(tenantId, refId);
    this.#guard.assertTenantAllowed(tenantId);
    const result = await queryForTenant<SecretRefRow>(
      this.database,
      tenantId,
      `SELECT binding_digest,metadata_json,revoked_at FROM pactmark_secret_refs
       WHERE tenant_id=$1 AND secret_ref_id=$2`,
      [tenantId, refId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const ref = assertStoredRef(row, tenantId, refId);
    this.#guard.assertPurposeAllowed(ref.purpose);
    return ref;
  }

  async revoke(tenantId: string, refId: string, revokedAt: string): Promise<void> {
    validateRoute(tenantId, refId);
    this.#guard.assertTenantAllowed(tenantId);
    await withTenantTransaction(this.database, tenantId, async (client) => {
      const row = await findRef(client, tenantId, refId, true);
      if (row === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
      const prior = assertStoredRef(row, tenantId, refId);
      this.#guard.assertPurposeAllowed(prior.purpose);
      const parsed = SecretRefSchema.safeParse({ ...prior, revokedAt });
      if (!parsed.success) {
        throw new KafError("KAF_SCHEMA_INVALID", {
          details: { path: "revokedAt", issue: parsed.error.issues[0]?.code ?? "invalid" },
          internalCause: parsed.error,
        });
      }
      const next = parsed.data;
      if (prior.revokedAt !== undefined) {
        if (prior.revokedAt !== next.revokedAt) conflict("secret_ref_revocation_changed");
        return;
      }
      await client.query(
        `UPDATE pactmark_secret_refs
         SET binding_digest=$3,revoked_at=$4::timestamptz,metadata_json=$5::jsonb
         WHERE tenant_id=$1 AND secret_ref_id=$2`,
        [tenantId, refId, digestCanonicalJson(next), next.revokedAt, JSON.stringify(next)],
      );
    });
  }
}

function findRef(
  client: PostgresClient,
  tenantId: string,
  refId: string,
  lock: boolean,
): Promise<SecretRefRow | undefined> {
  return client
    .query<SecretRefRow>(
      `SELECT binding_digest,metadata_json,revoked_at FROM pactmark_secret_refs
       WHERE tenant_id=$1 AND secret_ref_id=$2${lock ? " FOR UPDATE" : ""}`,
      [tenantId, refId],
    )
    .then((result) => result.rows[0]);
}

function assertStoredRef(
  row: SecretRefRow,
  tenantId: string,
  refId: string,
  expected?: SecretRef,
): SecretRef {
  const ref = SecretRefSchema.parse(parseJsonColumn(row.metadata_json));
  if (
    ref.tenantId !== tenantId ||
    ref.refId !== refId ||
    digestCanonicalJson(ref) !== row.binding_digest ||
    (row.revoked_at === null) !== (ref.revokedAt === undefined) ||
    (row.revoked_at !== null && new Date(row.revoked_at).toISOString() !== ref.revokedAt)
  ) {
    conflict("secret_ref_binding_changed");
  }
  if (expected !== undefined && canonicalJsonStringify(ref) !== canonicalJsonStringify(expected)) {
    conflict("immutable_secret_ref_changed");
  }
  return ref;
}

function validateRoute(tenantId: string, refId: string): void {
  assertNonempty(tenantId, "tenantId");
  assertNonempty(refId, "refId");
}
