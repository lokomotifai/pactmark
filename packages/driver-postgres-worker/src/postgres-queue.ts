import {
  DurableWakeupRequestSchema,
  ExecutionDefinitionRefSchema,
  KafError,
  PrincipalSchema,
  PurposeSchema,
  ResourceScopeSchema,
  RunLeaseSchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  type RunLease,
} from "@pactmark/core";
import { z } from "zod";

import {
  WorkerWakeupClaimSchema,
  type PostgresWorkerQueue,
  type WorkerWakeupClaim,
} from "./worker-queue-contracts.js";

export interface WorkerSqlResult<Row extends object = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface WorkerPostgresClient {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<WorkerSqlResult<Row>>;
  release(): void;
}

export interface WorkerPostgresDatabase {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<WorkerSqlResult<Row>>;
  connect(): Promise<WorkerPostgresClient>;
}

export interface DurablePostgresWorkerQueueOptions {
  readonly allowedTenants: readonly string[];
}

type WakeupRow = {
  tenant_id: string;
  run_id: string;
  wakeup_id: string;
  delegation_json: unknown;
  request_digest: string;
  work_order_id: string;
  claim_fencing_token: string | number;
  principal_type: string;
  principal_id: string;
  work_order_binding_digest: string;
  execution_definition_json: unknown;
  execution_definition_digest: string;
  purpose_code: string;
  purpose_registry_version: string;
  resource_scope_ceiling_json: unknown;
};

type LeaseRow = {
  tenant_id: string;
  run_id: string;
  lease_id: string;
  holder_id: string;
  fencing_token: string | number;
  acquired_at: string | Date;
  expires_at: string | Date;
  state: string;
};

type StaleRow = {
  tenant_id: string;
  run_id: string;
  wakeup_id: string;
  claim_lease_id: string;
  claim_fencing_token: string | number;
  claimed_by: string;
};

const ClaimInputSchema = z
  .object({
    holderId: z.string().trim().min(1).max(256),
    now: z.iso.datetime({ offset: true }),
    limit: z.number().int().min(1).max(256),
    leaseTtlMs: z.number().int().min(1_000).max(3_600_000),
  })
  .strict();

export class DurablePostgresWorkerQueue implements PostgresWorkerQueue {
  readonly transactionDomain = "postgres";
  readonly atomicCommandAndWakeup = true;
  readonly #allowedTenants: readonly string[];
  readonly #allowedTenantSet: ReadonlySet<string>;

  constructor(
    readonly database: WorkerPostgresDatabase,
    options: DurablePostgresWorkerQueueOptions,
  ) {
    this.#allowedTenants = Object.freeze(
      z.array(z.string().trim().min(1).max(256)).min(1).max(1_024).parse(options.allowedTenants),
    );
    this.#allowedTenantSet = new Set(this.#allowedTenants);
  }

  #assertTenantAllowed(tenantId: string): void {
    if (!this.#allowedTenantSet.has(tenantId)) {
      throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
        details: { reason: "worker_tenant_denied" },
      });
    }
  }

  recoverStale(now: string): Promise<number> {
    z.iso.datetime({ offset: true }).parse(now);
    return withWorkerTransaction(this.database, async (client) => {
      const stale = await client.query<StaleRow>(
        `SELECT tenant_id,run_id,wakeup_id,claim_lease_id,claim_fencing_token,claimed_by
         FROM pactmark_wakeups
         WHERE state='claimed' AND claimed_until <= clock_timestamp()
           AND tenant_id = ANY($1::text[])
         ORDER BY claimed_until,tenant_id,wakeup_id
         FOR UPDATE SKIP LOCKED`,
        [this.#allowedTenants],
      );
      for (const row of stale.rows) {
        const lease = await client.query(
          `UPDATE pactmark_run_leases SET state='expired',expires_at=LEAST(expires_at,clock_timestamp())
           WHERE tenant_id=$1 AND run_id=$2 AND lease_id=$3 AND fencing_token=$4
             AND holder_id=$5 AND state IN ('active','expired')`,
          [
            row.tenant_id,
            row.run_id,
            row.claim_lease_id,
            Number(row.claim_fencing_token),
            row.claimed_by,
          ],
        );
        if (lease.rowCount !== 1) conflict("stale_wakeup_lease_binding_changed");
        const wakeup = await client.query(
          `UPDATE pactmark_wakeups SET state='pending',available_at=clock_timestamp(),
             claimed_by=NULL,claimed_until=NULL,claim_lease_id=NULL,
             release_reason_code='KAF_STORAGE_LEASE_EXPIRED'
           WHERE tenant_id=$1 AND run_id=$2 AND wakeup_id=$3 AND state='claimed'
             AND claim_lease_id=$4 AND claim_fencing_token=$5 AND claimed_by=$6`,
          [
            row.tenant_id,
            row.run_id,
            row.wakeup_id,
            row.claim_lease_id,
            Number(row.claim_fencing_token),
            row.claimed_by,
          ],
        );
        if (wakeup.rowCount !== 1) conflict("stale_wakeup_binding_changed");
      }
      return stale.rowCount;
    });
  }

  claim(
    inputValue: Readonly<{ holderId: string; now: string; limit: number; leaseTtlMs: number }>,
  ) {
    const input = ClaimInputSchema.parse(inputValue);
    return withWorkerTransaction(this.database, async (client) => {
      const candidates = await client.query<WakeupRow>(
        `SELECT w.tenant_id,w.run_id,w.wakeup_id,w.delegation_json,w.request_digest,
                w.work_order_id,w.claim_fencing_token,wo.principal_type,wo.principal_id,
                wo.work_order_binding_digest,wo.execution_definition_json,
                wo.execution_definition_digest,wo.purpose_code,wo.purpose_registry_version,
                wo.resource_scope_ceiling_json
         FROM pactmark_wakeups w
         JOIN pactmark_run_work_orders rb
           ON rb.tenant_id=w.tenant_id AND rb.run_id=w.run_id AND rb.work_order_id=w.work_order_id
         JOIN pactmark_work_orders wo
           ON wo.tenant_id=rb.tenant_id AND wo.work_order_id=rb.work_order_id
          AND wo.work_order_binding_digest=rb.work_order_binding_digest
          AND wo.execution_definition_digest=rb.execution_definition_digest
         WHERE w.state='pending' AND w.available_at <= clock_timestamp()
           AND w.tenant_id = ANY($2::text[])
           AND wo.principal_type IS NOT NULL AND wo.principal_id IS NOT NULL
           AND wo.purpose_registry_version IS NOT NULL
           AND wo.resource_scope_ceiling_json IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM pactmark_run_leases active_lease
             WHERE active_lease.tenant_id=w.tenant_id AND active_lease.run_id=w.run_id
               AND active_lease.state='active'
               AND active_lease.expires_at > clock_timestamp()
           )
         ORDER BY w.available_at,w.tenant_id,w.wakeup_id
         FOR UPDATE OF w SKIP LOCKED LIMIT $1`,
        [input.limit, this.#allowedTenants],
      );
      const claims: WorkerWakeupClaim[] = [];
      const claimedRuns = new Set<string>();
      for (const row of candidates.rows) {
        const runKey = canonicalJsonStringify([row.tenant_id, row.run_id]);
        if (claimedRuns.has(runKey)) continue;
        const nextAttempt = Number(row.claim_fencing_token) + 1;
        const leaseId = `worker-lease:${digestCanonicalJson({
          schemaVersion: "1",
          receiptId: row.wakeup_id,
          nextAttempt,
        })}`;
        const acquired = await client.query<LeaseRow>(
          `INSERT INTO pactmark_run_leases
           (tenant_id,run_id,lease_id,holder_id,fencing_token,acquired_at,expires_at,state)
           VALUES ($1,$2,$3,$4,1,clock_timestamp(),
             clock_timestamp()+($5*interval '1 millisecond'),'active')
           ON CONFLICT (tenant_id,run_id) DO UPDATE SET
             lease_id=EXCLUDED.lease_id,holder_id=EXCLUDED.holder_id,
             fencing_token=pactmark_run_leases.fencing_token+1,
             acquired_at=clock_timestamp(),
             expires_at=clock_timestamp()+($5*interval '1 millisecond'),state='active'
           WHERE pactmark_run_leases.state <> 'active'
              OR pactmark_run_leases.expires_at <= clock_timestamp()
           RETURNING tenant_id,run_id,lease_id,holder_id,fencing_token,acquired_at,expires_at,state`,
          [row.tenant_id, row.run_id, leaseId, input.holderId, input.leaseTtlMs],
        );
        const leaseRow = acquired.rows[0];
        if (leaseRow === undefined) continue;
        const lease = parseLease(leaseRow);
        const updated = await client.query(
          `UPDATE pactmark_wakeups SET state='claimed',claimed_by=$4,
             claimed_until=$5::timestamptz,claim_lease_id=$6,
             claim_fencing_token=$7,claim_attempts=claim_attempts+1,
             release_reason_code=NULL
           WHERE tenant_id=$1 AND run_id=$2 AND wakeup_id=$3 AND state='pending'
             AND request_digest=$8 AND work_order_id=$9`,
          [
            row.tenant_id,
            row.run_id,
            row.wakeup_id,
            input.holderId,
            lease.expiresAt,
            lease.leaseId,
            lease.fencingToken,
            row.request_digest,
            row.work_order_id,
          ],
        );
        if (updated.rowCount !== 1) conflict("wakeup_claim_changed");
        claims.push(parseClaim(row, lease));
        claimedRuns.add(runKey);
      }
      return claims;
    });
  }

  renew(claimInput: WorkerWakeupClaim, now: string, leaseTtlMs: number) {
    const claim = WorkerWakeupClaimSchema.parse(claimInput);
    this.#assertTenantAllowed(claim.request.tenantId);
    z.iso.datetime({ offset: true }).parse(now);
    z.number().int().min(1_000).max(3_600_000).parse(leaseTtlMs);
    return withWorkerTransaction(this.database, async (client) => {
      const renewed = await client.query<LeaseRow>(
        `UPDATE pactmark_run_leases SET expires_at=clock_timestamp()+($6*interval '1 millisecond')
         WHERE tenant_id=$1 AND run_id=$2 AND lease_id=$3 AND holder_id=$4
           AND fencing_token=$5 AND state='active' AND expires_at > clock_timestamp()
         RETURNING tenant_id,run_id,lease_id,holder_id,fencing_token,acquired_at,expires_at,state`,
        leaseValues(claim, leaseTtlMs),
      );
      const row = renewed.rows[0];
      if (row === undefined) conflict("wakeup_renew_stale_lease");
      const lease = parseLease(row);
      const wakeup = await client.query(
        `UPDATE pactmark_wakeups SET claimed_until=$10::timestamptz
         WHERE tenant_id=$1 AND run_id=$2 AND wakeup_id=$3 AND request_digest=$4
           AND work_order_id=$5 AND state='claimed' AND claimed_by=$6
           AND claim_lease_id=$7 AND claim_fencing_token=$8
           AND claim_attempts > 0 AND claimed_until=$9::timestamptz`,
        [...claimBindingValues(claim), claim.lease.expiresAt, lease.expiresAt],
      );
      if (wakeup.rowCount !== 1) conflict("wakeup_renew_binding_changed");
      return WorkerWakeupClaimSchema.parse({ ...claim, lease });
    });
  }

  complete(
    claimInput: WorkerWakeupClaim,
    result: Readonly<{ status: "completed" | "parked" | "failed"; completedAt: string }>,
  ): Promise<void> {
    const claim = WorkerWakeupClaimSchema.parse(claimInput);
    this.#assertTenantAllowed(claim.request.tenantId);
    const parsed = z
      .object({
        status: z.enum(["completed", "parked", "failed"]),
        completedAt: z.iso.datetime({ offset: true }),
      })
      .strict()
      .parse(result);
    return withWorkerTransaction(this.database, async (client) => {
      const wakeup = await client.query(
        `UPDATE pactmark_wakeups SET state='completed',claim_result_status=$9,
           completed_at=$10::timestamptz
         WHERE tenant_id=$1 AND run_id=$2 AND wakeup_id=$3 AND request_digest=$4
           AND work_order_id=$5 AND state='claimed' AND claimed_by=$6
           AND claim_lease_id=$7 AND claim_fencing_token=$8`,
        [...claimBindingValues(claim), parsed.status, parsed.completedAt],
      );
      if (wakeup.rowCount !== 1) conflict("wakeup_complete_binding_changed");
      await releaseExactLease(client, claim, "released");
    });
  }

  release(
    claimInput: WorkerWakeupClaim,
    retry: Readonly<{ retryAt: string; reasonCode: string }>,
  ): Promise<void> {
    const claim = WorkerWakeupClaimSchema.parse(claimInput);
    this.#assertTenantAllowed(claim.request.tenantId);
    const parsed = z
      .object({
        retryAt: z.iso.datetime({ offset: true }),
        reasonCode: z.string().regex(/^KAF_[A-Z0-9_]+$/u),
      })
      .strict()
      .parse(retry);
    return withWorkerTransaction(this.database, async (client) => {
      const wakeup = await client.query(
        `UPDATE pactmark_wakeups SET state='pending',available_at=$9::timestamptz,
           claimed_by=NULL,claimed_until=NULL,claim_lease_id=NULL,release_reason_code=$10
         WHERE tenant_id=$1 AND run_id=$2 AND wakeup_id=$3 AND request_digest=$4
           AND work_order_id=$5 AND state='claimed' AND claimed_by=$6
           AND claim_lease_id=$7 AND claim_fencing_token=$8`,
        [...claimBindingValues(claim), parsed.retryAt, parsed.reasonCode],
      );
      if (wakeup.rowCount !== 1) conflict("wakeup_release_binding_changed");
      await releaseExactLease(client, claim, "released");
    });
  }
}

function parseClaim(row: WakeupRow, lease: RunLease): WorkerWakeupClaim {
  const request = DurableWakeupRequestSchema.parse(parseJson(row.delegation_json));
  if (
    request.tenantId !== row.tenant_id ||
    request.runId !== row.run_id ||
    digestCanonicalJson(request) !== row.request_digest
  ) {
    conflict("wakeup_request_binding_changed");
  }
  const executionDefinition = ExecutionDefinitionRefSchema.parse(
    parseJson(row.execution_definition_json),
  );
  if (digestCanonicalJson(executionDefinition) !== row.execution_definition_digest) {
    conflict("worker_execution_definition_digest_changed");
  }
  return WorkerWakeupClaimSchema.parse({
    schemaVersion: "1",
    receiptId: row.wakeup_id,
    requestDigest: row.request_digest,
    request,
    initiatingPrincipal: PrincipalSchema.parse({
      type: row.principal_type,
      id: row.principal_id,
    }),
    workOrderId: row.work_order_id,
    workOrderBindingDigest: row.work_order_binding_digest,
    executionDefinition,
    executionDefinitionDigest: row.execution_definition_digest,
    purpose: PurposeSchema.parse({
      code: row.purpose_code,
      registryVersion: row.purpose_registry_version,
    }),
    maximumScopes: z
      .array(ResourceScopeSchema)
      .max(256)
      .parse(parseJson(row.resource_scope_ceiling_json)),
    lease,
    claimedAt: lease.acquiredAt,
  });
}

function parseLease(row: LeaseRow): RunLease {
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

function claimBindingValues(claim: WorkerWakeupClaim): readonly unknown[] {
  return [
    claim.request.tenantId,
    claim.request.runId,
    claim.receiptId,
    claim.requestDigest,
    claim.workOrderId,
    claim.lease.holderId,
    claim.lease.leaseId,
    claim.lease.fencingToken,
  ];
}

function leaseValues(claim: WorkerWakeupClaim, leaseTtlMs: number): readonly unknown[] {
  return [
    claim.lease.tenantId,
    claim.lease.runId,
    claim.lease.leaseId,
    claim.lease.holderId,
    claim.lease.fencingToken,
    leaseTtlMs,
  ];
}

async function releaseExactLease(
  client: WorkerPostgresClient,
  claim: WorkerWakeupClaim,
  state: "released" | "expired",
): Promise<void> {
  const result = await client.query(
    `UPDATE pactmark_run_leases SET state=$6,expires_at=LEAST(expires_at,clock_timestamp())
     WHERE tenant_id=$1 AND run_id=$2 AND lease_id=$3 AND holder_id=$4
       AND fencing_token=$5 AND state='active'`,
    [
      claim.lease.tenantId,
      claim.lease.runId,
      claim.lease.leaseId,
      claim.lease.holderId,
      claim.lease.fencingToken,
      state,
    ],
  );
  if (result.rowCount !== 1) conflict("wakeup_lease_completion_stale");
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function instant(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function conflict(reason: string): never {
  throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", { details: { reason } });
}

async function withWorkerTransaction<T>(
  database: WorkerPostgresDatabase,
  operation: (client: WorkerPostgresClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
