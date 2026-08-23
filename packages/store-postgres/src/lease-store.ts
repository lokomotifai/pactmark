import {
  RunLeaseSchema,
  type RunLease,
  type RunLeaseStore,
  type StorageSecurityProfile,
} from "@pactmark/core";
import { PostgresStorageGuard } from "./config.js";
import type { PostgresClient, PostgresDatabase } from "./database.js";
import { queryForTenant } from "./database.js";
import { assertNonempty, assertPositive, conflict } from "./internal.js";

type LeaseRow = {
  lease_id: string;
  tenant_id: string;
  run_id: string;
  holder_id: string;
  fencing_token: string | number;
  acquired_at: string | Date;
  expires_at: string | Date;
  state: "active" | "released" | "expired";
};

export interface PostgresRunLeaseStoreOptions {
  readonly generateLeaseId?: (input: Readonly<{ tenantId: string; runId: string }>) => string;
  readonly securityProfile: StorageSecurityProfile;
}

export class PostgresRunLeaseStore implements RunLeaseStore {
  readonly #generateLeaseId: NonNullable<PostgresRunLeaseStoreOptions["generateLeaseId"]>;
  readonly #guard: PostgresStorageGuard;
  readonly securityProfile: StorageSecurityProfile;
  constructor(
    readonly database: PostgresDatabase,
    options: PostgresRunLeaseStoreOptions,
  ) {
    this.#generateLeaseId = options.generateLeaseId ?? (() => crypto.randomUUID());
    this.securityProfile = options.securityProfile;
    this.#guard = new PostgresStorageGuard(this.securityProfile);
  }

  async acquire(
    tenantId: string,
    runId: string,
    holderId: string,
    ttlMs: number,
  ): Promise<RunLease | undefined> {
    assertNonempty(tenantId, "tenantId");
    assertNonempty(runId, "runId");
    this.#guard.assertTenantAllowed(tenantId);
    assertNonempty(holderId, "holderId");
    assertPositive(ttlMs, "ttlMs");
    const result = await queryForTenant<LeaseRow>(
      this.database,
      tenantId,
      `
      INSERT INTO pactmark_run_leases
        (tenant_id, run_id, lease_id, holder_id, fencing_token, acquired_at, expires_at, state)
      VALUES ($1,$2,$3,$4,1,clock_timestamp(),clock_timestamp()+$5::bigint*interval '1 millisecond','active')
      ON CONFLICT (tenant_id, run_id) DO UPDATE SET
        lease_id=EXCLUDED.lease_id, holder_id=EXCLUDED.holder_id,
        fencing_token=pactmark_run_leases.fencing_token+1, acquired_at=clock_timestamp(),
        expires_at=clock_timestamp()+$5::bigint*interval '1 millisecond', state='active'
      WHERE pactmark_run_leases.state <> 'active' OR pactmark_run_leases.expires_at <= clock_timestamp()
      RETURNING *`,
      [tenantId, runId, this.#generateLeaseId({ tenantId, runId }), holderId, ttlMs],
    );
    return result.rows[0] === undefined ? undefined : toLease(result.rows[0]);
  }

  async renew(input: RunLease, ttlMs: number): Promise<RunLease> {
    const lease = RunLeaseSchema.parse(input);
    this.#guard.assertTenantAllowed(lease.tenantId);
    assertPositive(ttlMs, "ttlMs");
    const result = await queryForTenant<LeaseRow>(
      this.database,
      lease.tenantId,
      `
      UPDATE pactmark_run_leases SET expires_at=clock_timestamp()+$6::bigint*interval '1 millisecond'
      WHERE tenant_id=$1 AND run_id=$2 AND lease_id=$3 AND holder_id=$4 AND fencing_token=$5
        AND state='active' AND expires_at > clock_timestamp()
      RETURNING *`,
      [lease.tenantId, lease.runId, lease.leaseId, lease.holderId, lease.fencingToken, ttlMs],
    );
    if (result.rows[0] === undefined) conflict("stale_or_expired_lease");
    return toLease(result.rows[0]);
  }

  async release(input: RunLease): Promise<void> {
    const lease = RunLeaseSchema.parse(input);
    this.#guard.assertTenantAllowed(lease.tenantId);
    const result = await queryForTenant(
      this.database,
      lease.tenantId,
      `
      UPDATE pactmark_run_leases SET state='released'
      WHERE tenant_id=$1 AND run_id=$2 AND lease_id=$3 AND holder_id=$4 AND fencing_token=$5
        AND state='active' AND expires_at > clock_timestamp()`,
      [lease.tenantId, lease.runId, lease.leaseId, lease.holderId, lease.fencingToken],
    );
    if (result.rowCount !== 1) conflict("stale_or_expired_lease");
  }

  async assertActive(client: PostgresClient, input: RunLease): Promise<void> {
    const lease = RunLeaseSchema.parse(input);
    this.#guard.assertTenantAllowed(lease.tenantId);
    const result = await client.query(
      `SELECT 1 FROM pactmark_run_leases
      WHERE tenant_id=$1 AND run_id=$2 AND lease_id=$3 AND holder_id=$4 AND fencing_token=$5
        AND state='active' AND expires_at > clock_timestamp() FOR UPDATE`,
      [lease.tenantId, lease.runId, lease.leaseId, lease.holderId, lease.fencingToken],
    );
    if (result.rowCount !== 1) conflict("stale_or_expired_fence");
  }
}

function toLease(row: LeaseRow): RunLease {
  return RunLeaseSchema.parse({
    schemaVersion: "1",
    leaseId: row.lease_id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    holderId: row.holder_id,
    fencingToken: Number(row.fencing_token),
    acquiredAt: instant(row.acquired_at),
    expiresAt: instant(row.expires_at),
    state: row.state,
  });
}
function instant(value: string | Date): string {
  return new Date(value).toISOString();
}
