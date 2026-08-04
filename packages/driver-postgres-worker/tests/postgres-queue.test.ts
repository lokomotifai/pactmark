import { describe, expect, it } from "vitest";
import { digestBytes, digestCanonicalJson, type DurableWakeupRequest } from "@pactmark/core";

import {
  DurablePostgresWorkerQueue,
  type WorkerPostgresClient,
  type WorkerPostgresDatabase,
  type WorkerSqlResult,
} from "../src/index.js";

const now = "2026-08-03T12:00:00.000Z";
const later = "2026-08-03T12:01:00.000Z";
const digest = (value: string) => digestBytes(new TextEncoder().encode(value));
const request: DurableWakeupRequest = {
  schemaVersion: "1",
  tenantId: "tenant-1",
  runId: "run-1",
  reason: "run_accepted",
  notBefore: now,
  deduplicationKey: "command-1",
  payload: {},
};

describe("DurablePostgresWorkerQueue SQL contract", () => {
  it("lets two workers claim one row once with SKIP LOCKED and database time", async () => {
    const database = new QueueDatabaseDouble();
    const first = new DurablePostgresWorkerQueue(database);
    const second = new DurablePostgresWorkerQueue(database);
    const claims = (
      await Promise.all([
        first.claim({ holderId: "worker-1", now, limit: 1, leaseTtlMs: 30_000 }),
        second.claim({ holderId: "worker-2", now, limit: 1, leaseTtlMs: 30_000 }),
      ])
    ).flat();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      receiptId: "receipt-1",
      request,
      initiatingPrincipal: { type: "user", id: "person-1" },
      workOrderId: "work-1",
      lease: { holderId: "worker-1", fencingToken: 1 },
      claimedAt: now,
    });
    expect(database.statements.join("\n")).toContain("FOR UPDATE OF w SKIP LOCKED");
    expect(database.statements.join("\n")).toContain("clock_timestamp()");
    expect(database.statements.filter((statement) => statement === "COMMIT")).toHaveLength(2);
  });

  it("renews and completes only the exact receipt/request/work-order/lease/fence binding", async () => {
    const database = new QueueDatabaseDouble();
    const queue = new DurablePostgresWorkerQueue(database);
    const [claimed] = await queue.claim({
      holderId: "worker-1",
      now,
      limit: 1,
      leaseTtlMs: 30_000,
    });
    if (claimed === undefined) throw new Error("claim missing");
    const renewed = await queue.renew(claimed, now, 60_000);
    expect(renewed.lease.expiresAt).toBe(later);
    await expect(
      queue.complete(
        { ...renewed, lease: { ...renewed.lease, fencingToken: 0 } },
        { status: "completed", completedAt: later },
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      queue.complete(renewed, { status: "parked", completedAt: later }),
    ).resolves.toBeUndefined();
    await expect(
      queue.complete(renewed, { status: "completed", completedAt: later }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
  });

  it("recovers one stale claim and rejects the stale completion after a fenced retry", async () => {
    const database = new QueueDatabaseDouble();
    const first = new DurablePostgresWorkerQueue(database);
    const [stale] = await first.claim({
      holderId: "worker-1",
      now,
      limit: 1,
      leaseTtlMs: 30_000,
    });
    if (stale === undefined) throw new Error("claim missing");
    database.expireClaim();
    const recovered = await Promise.all([
      first.recoverStale(later),
      new DurablePostgresWorkerQueue(database).recoverStale(later),
    ]);
    expect(recovered.reduce((sum, value) => sum + value, 0)).toBe(1);
    const freshQueue = new DurablePostgresWorkerQueue(database);
    const [fresh] = await freshQueue.claim({
      holderId: "worker-2",
      now: later,
      limit: 1,
      leaseTtlMs: 30_000,
    });
    if (fresh === undefined) throw new Error("fresh claim missing");
    expect(fresh.lease.fencingToken).toBeGreaterThan(stale.lease.fencingToken);
    await expect(
      first.complete(stale, { status: "completed", completedAt: later }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      freshQueue.release(fresh, {
        retryAt: "2026-08-03T12:02:00.000Z",
        reasonCode: "KAF_RUNTIME_WORKER_FAILURE",
      }),
    ).resolves.toBeUndefined();
  });
});

class QueueDatabaseDouble implements WorkerPostgresDatabase, WorkerPostgresClient {
  readonly statements: string[] = [];
  pending = true;
  claimed = false;
  completed = false;
  selectLocked = false;
  leaseActive = false;
  leaseFence = 0;
  holder = "";
  leaseId = "";
  expiresAt = "2026-08-03T12:00:30.000Z";
  stale = false;

  connect(): Promise<WorkerPostgresClient> {
    return Promise.resolve(this);
  }
  release(): void {}
  expireClaim(): void {
    this.stale = true;
    this.expiresAt = "2026-08-03T11:59:59.000Z";
  }

  async query<Row extends object>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<WorkerSqlResult<Row>> {
    await Promise.resolve();
    const sql = text.replace(/\s+/gu, " ").trim();
    this.statements.push(sql);
    if (sql === "COMMIT" || sql === "ROLLBACK") this.selectLocked = false;
    if (sql.includes("FROM pactmark_wakeups") && sql.includes("FOR UPDATE OF w SKIP LOCKED")) {
      if (!this.pending || this.selectLocked) return result<Row>();
      this.selectLocked = true;
      return result<Row>([this.wakeupRow()]);
    }
    if (sql.startsWith("INSERT INTO pactmark_run_leases")) {
      if (this.leaseActive && !this.stale) return result<Row>();
      this.leaseFence += 1;
      this.leaseActive = true;
      this.stale = false;
      this.leaseId = String(values[2]);
      this.holder = String(values[3]);
      this.expiresAt = "2026-08-03T12:00:30.000Z";
      return result<Row>([this.leaseRow()]);
    }
    if (sql.startsWith("UPDATE pactmark_wakeups SET state='claimed'")) {
      if (!this.pending) return result<Row>();
      this.pending = false;
      this.claimed = true;
      return result<Row>([{}]);
    }
    if (sql.startsWith("UPDATE pactmark_run_leases SET expires_at=")) {
      if (!this.exactLease(values)) return result<Row>();
      this.expiresAt = later;
      return result<Row>([this.leaseRow()]);
    }
    if (sql.startsWith("UPDATE pactmark_wakeups SET claimed_until=")) {
      return result<Row>(this.exactClaim(values) ? [{}] : []);
    }
    if (sql.startsWith("UPDATE pactmark_wakeups SET state='completed'")) {
      if (!this.exactClaim(values)) return result<Row>();
      this.claimed = false;
      this.completed = true;
      return result<Row>([{}]);
    }
    if (sql.startsWith("UPDATE pactmark_run_leases SET state=$6")) {
      if (!this.exactLease(values)) return result<Row>();
      this.leaseActive = false;
      return result<Row>([{}]);
    }
    if (sql.includes("WHERE state='claimed' AND claimed_until <= clock_timestamp()")) {
      if (!this.claimed || !this.stale || this.selectLocked) return result<Row>();
      this.selectLocked = true;
      return result<Row>([
        {
          tenant_id: "tenant-1",
          run_id: "run-1",
          wakeup_id: "receipt-1",
          claim_lease_id: this.leaseId,
          claim_fencing_token: this.leaseFence,
          claimed_by: this.holder,
        },
      ]);
    }
    if (sql.startsWith("UPDATE pactmark_run_leases SET state='expired'")) {
      this.leaseActive = false;
      return result<Row>([{}]);
    }
    if (sql.startsWith("UPDATE pactmark_wakeups SET state='pending'")) {
      if (!this.claimed) return result<Row>();
      this.claimed = false;
      this.pending = true;
      return result<Row>([{}]);
    }
    return result<Row>();
  }

  private wakeupRow() {
    return {
      tenant_id: "tenant-1",
      run_id: "run-1",
      wakeup_id: "receipt-1",
      delegation_json: request,
      request_digest: digestCanonicalJson(request),
      work_order_id: "work-1",
      claim_fencing_token: this.leaseFence,
      principal_type: "user",
      principal_id: "person-1",
      work_order_binding_digest: digest("work-order"),
      execution_definition_json: {
        kind: "agent",
        id: "agent-1",
        version: "0.1.0",
        agentDefinitionDigest: digest("agent"),
      },
      execution_definition_digest: digestCanonicalJson({
        kind: "agent",
        id: "agent-1",
        version: "0.1.0",
        agentDefinitionDigest: digest("agent"),
      }),
      purpose_code: "test",
      purpose_registry_version: "1",
      resource_scope_ceiling_json: [{ kind: "record", value: "1", normalizationVersion: "1" }],
    };
  }

  private leaseRow() {
    return {
      tenant_id: "tenant-1",
      run_id: "run-1",
      lease_id: this.leaseId,
      holder_id: this.holder,
      fencing_token: this.leaseFence,
      acquired_at: now,
      expires_at: this.expiresAt,
      state: "active",
    };
  }

  private exactLease(values: readonly unknown[]): boolean {
    return (
      this.leaseActive &&
      values[0] === "tenant-1" &&
      values[1] === "run-1" &&
      values[2] === this.leaseId &&
      values[3] === this.holder &&
      Number(values[4]) === this.leaseFence
    );
  }

  private exactClaim(values: readonly unknown[]): boolean {
    return (
      this.claimed &&
      values[0] === "tenant-1" &&
      values[1] === "run-1" &&
      values[2] === "receipt-1" &&
      values[3] === digestCanonicalJson(request) &&
      values[4] === "work-1" &&
      values[5] === this.holder &&
      values[6] === this.leaseId &&
      Number(values[7]) === this.leaseFence
    );
  }
}

function result<Row extends object>(rows: readonly object[] = []): WorkerSqlResult<Row> {
  return { rows: rows as readonly Row[], rowCount: rows.length };
}
