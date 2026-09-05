import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type {
  PostgresClient,
  PostgresDatabase,
  PostgresMaintenanceDatabase,
  SqlResult,
} from "../src/database.js";
import { PostgresRetentionMaintenance } from "../src/retention-maintenance.js";

describe("operator retention boundary", () => {
  it("rejects an ordinary application database before issuing global SQL", () => {
    const database = new OrdinaryDatabase();
    expect(() => new PostgresRetentionMaintenance(database as never)).toThrow(
      expect.objectContaining({
        code: "KAF_RUNTIME_NOT_READY",
        details: { reason: "operator_retention_database_required" },
      }),
    );
    expect(database.statements).toEqual([]);
  });

  it("purges every protected store only through the explicit operator surface", async () => {
    const database = new MaintenanceDatabase();
    const deletions: unknown[] = [];
    const maintenance = new PostgresRetentionMaintenance(database, {
      now: () => "2026-08-05T00:00:00.000Z",
      onDelete: (record) => {
        deletions.push(record);
      },
    });
    await expect(maintenance.purgeAllExpired()).resolves.toEqual({
      acceptedWorkOrders: 1,
      inputSubmissions: 1,
      contexts: 1,
      artifacts: 1,
      total: 4,
    });
    expect(database.values).toEqual([
      ["2026-08-05T00:00:00.000Z"],
      ["2026-08-05T00:00:00.000Z"],
      ["2026-08-05T00:00:00.000Z"],
      ["2026-08-05T00:00:00.000Z"],
    ]);
    expect(database.statements).toHaveLength(4);
    expect(database.statements.every((statement) => !statement.includes("WHERE tenant_id"))).toBe(
      true,
    );
    expect(deletions).toEqual([
      {
        tenantId: "tenant-a",
        storeKind: "artifact",
        recordId: "artifact-expired",
        reason: "expired",
      },
      {
        tenantId: "tenant-a",
        storeKind: "context",
        recordId: "snapshot-expired",
        reason: "expired",
      },
      {
        tenantId: "tenant-a",
        storeKind: "input_submission",
        recordId: "run-expired/request-expired",
        reason: "expired",
      },
      {
        tenantId: "tenant-a",
        storeKind: "accepted_work_order",
        recordId: "work-order-expired",
        reason: "expired",
      },
    ]);
    await expect(maintenance.purgeExpiredArtifacts("not-a-timestamp")).rejects.toMatchObject({
      code: "KAF_SCHEMA_INVALID",
    });
    expect(database.statements).toHaveLength(4);
  });
});

class OrdinaryDatabase implements PostgresDatabase {
  readonly statements: string[] = [];

  query<Row extends QueryResultRow>(text: string): Promise<SqlResult<Row>> {
    this.statements.push(text);
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  connect(): Promise<PostgresClient> {
    return Promise.reject(new Error("not used"));
  }
}

class MaintenanceDatabase extends OrdinaryDatabase implements PostgresMaintenanceDatabase {
  readonly operatorMaintenance = true as const;
  readonly values: unknown[][] = [];

  override query<Row extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    this.statements.push(text);
    this.values.push([...values]);
    const row = text.includes("pactmark_artifacts")
      ? { tenant_id: "tenant-a", record_id: "artifact-expired" }
      : text.includes("pactmark_context_snapshots")
        ? { tenant_id: "tenant-a", record_id: "snapshot-expired" }
        : text.includes("pactmark_input_submissions")
          ? { tenant_id: "tenant-a", record_id: "run-expired/request-expired" }
          : { tenant_id: "tenant-a", record_id: "work-order-expired" };
    return Promise.resolve({ rows: [row] as unknown as Row[], rowCount: 1 });
  }
}
