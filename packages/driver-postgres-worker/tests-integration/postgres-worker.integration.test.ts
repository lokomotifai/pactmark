import { randomUUID } from "node:crypto";

import { Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digestBytes, digestCanonicalJson, type DurableWakeupRequest } from "@pactmark/core";

import {
  DurablePostgresWorkerQueue,
  type WorkerPostgresDatabase,
  type WorkerSqlResult,
} from "../src/index.js";

const connectionString = process.env.PACTMARK_TEST_POSTGRES_URL;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("PACTMARK_TEST_POSTGRES_URL must identify a disposable PostgreSQL database");
}

describe("real PostgreSQL worker queue", () => {
  const schema = `pactmark_worker_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 4 });
  const scopedUrl = new URL(connectionString);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: scopedUrl.toString(), max: 20 });
  const database: WorkerPostgresDatabase = {
    query: async <Row extends object>(
      text: string,
      values?: readonly unknown[],
    ): Promise<WorkerSqlResult<Row>> => {
      const result = await pool.query<Row & QueryResultRow>(text, values as unknown[] | undefined);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async <Row extends object>(
          text: string,
          values?: readonly unknown[],
        ): Promise<WorkerSqlResult<Row>> => {
          const result = await client.query<Row & QueryResultRow>(
            text,
            values as unknown[] | undefined,
          );
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
        release: () => {
          client.release();
        },
      };
    },
  };

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await database.query(WORKER_SCHEMA_SQL);
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("claims once, fences stale completion, recovers once, and resumes durable reasons in a fresh worker", async () => {
    await insertWakeup(database, "first", "run_accepted");
    const workerOne = new DurablePostgresWorkerQueue(database);
    const workerTwo = new DurablePostgresWorkerQueue(database);
    const firstClaims = (
      await Promise.all([
        workerOne.claim({ holderId: "worker-1", now: NOW, limit: 1, leaseTtlMs: 30_000 }),
        workerTwo.claim({ holderId: "worker-2", now: NOW, limit: 1, leaseTtlMs: 30_000 }),
      ])
    ).flat();
    expect(firstClaims).toHaveLength(1);
    const stale = firstClaims[0];
    if (stale === undefined) throw new Error("first claim missing");
    await expect(
      workerOne.complete(
        { ...stale, lease: { ...stale.lease, fencingToken: stale.lease.fencingToken + 1 } },
        { status: "completed", completedAt: NOW },
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });

    await database.query(
      `UPDATE pactmark_wakeups SET claimed_until=clock_timestamp()-interval '1 second'
       WHERE wakeup_id=$1`,
      [stale.receiptId],
    );
    await database.query(
      `UPDATE pactmark_run_leases SET expires_at=clock_timestamp()-interval '1 second'
       WHERE tenant_id=$1 AND run_id=$2`,
      [stale.request.tenantId, stale.request.runId],
    );
    const recovered = await Promise.all([workerOne.recoverStale(NOW), workerTwo.recoverStale(NOW)]);
    expect(recovered.reduce((sum, value) => sum + value, 0)).toBe(1);

    const freshWorker = new DurablePostgresWorkerQueue(database);
    const [fresh] = await freshWorker.claim({
      holderId: "worker-fresh",
      now: NOW,
      limit: 1,
      leaseTtlMs: 30_000,
    });
    if (fresh === undefined) throw new Error("fresh claim missing");
    expect(fresh.lease.fencingToken).toBeGreaterThan(stale.lease.fencingToken);
    await expect(
      workerOne.complete(stale, { status: "completed", completedAt: NOW }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      freshWorker.complete(fresh, { status: "parked", completedAt: NOW }),
    ).resolves.toBeUndefined();

    await insertWakeup(database, "accepted", "run_accepted");
    await insertWakeup(database, "input", "input_submitted");
    await insertWakeup(database, "decision", "decision_recorded");
    // Issuing a challenge alone calls no enqueue path, so the durable count remains these four.
    const beforeFreshProcess = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pactmark_wakeups",
    );
    expect(beforeFreshProcess.rows[0]?.count).toBe("4");
    const replacementProcess = new DurablePostgresWorkerQueue(database);
    const continuation = await replacementProcess.claim({
      holderId: "worker-replacement",
      now: NOW,
      limit: 10,
      leaseTtlMs: 30_000,
    });
    expect(continuation.map((claim) => claim.request.reason).sort()).toEqual([
      "decision_recorded",
      "input_submitted",
      "run_accepted",
    ]);
    for (const claim of continuation) {
      await replacementProcess.complete(claim, { status: "completed", completedAt: NOW });
    }
    const finalStates = await database.query<{ state: string; count: string }>(
      "SELECT state,count(*)::text AS count FROM pactmark_wakeups GROUP BY state",
    );
    expect(finalStates.rows).toEqual([{ state: "completed", count: "4" }]);
  });
});

const NOW = "2026-08-03T12:00:00.000Z";
const digest = (value: string) => digestBytes(new TextEncoder().encode(value));

async function insertWakeup(
  database: WorkerPostgresDatabase,
  suffix: string,
  reason: DurableWakeupRequest["reason"],
): Promise<void> {
  const tenantId = `tenant-${suffix}`;
  const runId = `run-${suffix}`;
  const workOrderId = `work-${suffix}`;
  const executionDefinition = {
    kind: "agent" as const,
    id: "agent-1",
    version: "1.0.0",
    agentDefinitionDigest: digest("agent-definition"),
  };
  const executionDefinitionDigest = digestCanonicalJson(executionDefinition);
  const workOrderBindingDigest = digest(`work-order-${suffix}`);
  const request: DurableWakeupRequest = {
    schemaVersion: "1",
    tenantId,
    runId,
    reason,
    notBefore: "2020-01-01T00:00:00.000Z",
    deduplicationKey: `command-${suffix}`,
    payload: {},
  };
  await database.query(
    `INSERT INTO pactmark_work_orders
     (tenant_id,work_order_id,work_order_binding_digest,execution_definition_json,
      execution_definition_digest,principal_type,principal_id,purpose_code,
      purpose_registry_version,resource_scope_ceiling_json)
     VALUES ($1,$2,$3,$4::jsonb,$5,'user',$6,'test','1',$7::jsonb)`,
    [
      tenantId,
      workOrderId,
      workOrderBindingDigest,
      JSON.stringify(executionDefinition),
      executionDefinitionDigest,
      `principal-${suffix}`,
      JSON.stringify([{ kind: "run", value: runId, normalizationVersion: "1" }]),
    ],
  );
  await database.query(
    `INSERT INTO pactmark_run_work_orders
     (tenant_id,run_id,work_order_id,work_order_binding_digest,execution_definition_digest)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, runId, workOrderId, workOrderBindingDigest, executionDefinitionDigest],
  );
  await database.query(
    `INSERT INTO pactmark_wakeups
     (tenant_id,run_id,wakeup_id,deduplication_key,delegation_json,available_at,state,
      request_digest,work_order_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz,'pending',$7,$8)`,
    [
      tenantId,
      runId,
      `receipt-${suffix}`,
      request.deduplicationKey,
      JSON.stringify(request),
      request.notBefore,
      digestCanonicalJson(request),
      workOrderId,
    ],
  );
}

const WORKER_SCHEMA_SQL = `
CREATE TABLE pactmark_work_orders (
  tenant_id text NOT NULL, work_order_id text NOT NULL, work_order_binding_digest text NOT NULL,
  execution_definition_json jsonb NOT NULL, execution_definition_digest text NOT NULL,
  principal_type text NOT NULL, principal_id text NOT NULL, purpose_code text NOT NULL,
  purpose_registry_version text NOT NULL, resource_scope_ceiling_json jsonb NOT NULL,
  PRIMARY KEY (tenant_id,work_order_id)
);
CREATE TABLE pactmark_run_work_orders (
  tenant_id text NOT NULL, run_id text NOT NULL, work_order_id text NOT NULL,
  work_order_binding_digest text NOT NULL, execution_definition_digest text NOT NULL,
  PRIMARY KEY (tenant_id,run_id)
);
CREATE TABLE pactmark_run_leases (
  tenant_id text NOT NULL, run_id text NOT NULL, lease_id text NOT NULL, holder_id text NOT NULL,
  fencing_token bigint NOT NULL, acquired_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  state text NOT NULL, PRIMARY KEY (tenant_id,run_id)
);
CREATE TABLE pactmark_wakeups (
  tenant_id text NOT NULL, run_id text NOT NULL, wakeup_id text NOT NULL,
  deduplication_key text NOT NULL, delegation_json jsonb NOT NULL, available_at timestamptz NOT NULL,
  claimed_by text, claimed_until timestamptz, claim_fencing_token bigint NOT NULL DEFAULT 0,
  state text NOT NULL, request_digest text NOT NULL, work_order_id text NOT NULL,
  claim_lease_id text, claim_attempts bigint NOT NULL DEFAULT 0,
  claim_result_status text, completed_at timestamptz, release_reason_code text,
  PRIMARY KEY (tenant_id,wakeup_id), UNIQUE (tenant_id,deduplication_key)
);`;
