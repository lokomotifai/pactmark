import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type { PostgresClient, PostgresDatabase, SqlResult } from "../src/database.js";
import { withTransaction } from "../src/database.js";
import { PostgresRunLeaseStore } from "../src/lease-store.js";
import {
  POSTGRES_MIGRATIONS,
  PostgresMigrationManager,
  type PostgresMigration,
} from "../src/migrations.js";

describe("transaction boundary", () => {
  it("commits successful work and always releases the client", async () => {
    const database = new TransactionDatabase();
    await expect(
      withTransaction(database, async (client) => {
        await client.query("DOMAIN WRITE");
        return "done";
      }),
    ).resolves.toBe("done");
    expect(database.statements).toEqual(["BEGIN", "DOMAIN WRITE", "COMMIT"]);
    expect(database.released).toBe(true);
  });

  it("rolls back failed work and preserves the failure", async () => {
    const database = new TransactionDatabase();
    await expect(
      withTransaction(database, async () => {
        await Promise.resolve();
        throw new Error("crash boundary");
      }),
    ).rejects.toThrow("crash boundary");
    expect(database.statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(database.released).toBe(true);
  });
});

describe("explicit migrations", () => {
  const migration: PostgresMigration = {
    version: "001",
    description: "test migration",
    reversibleSafe: false,
    up: ["CREATE TABLE pactmark_test(id text PRIMARY KEY)"],
    down: ["DROP TABLE pactmark_test"],
  };

  it("reports status, applies once under an advisory transaction lock, and records a digest", async () => {
    const database = new MigrationDatabase();
    const manager = new PostgresMigrationManager(database, [migration]);
    await expect(manager.status()).resolves.toEqual({ currentVersion: "000", pending: ["001"] });
    await manager.migrate();
    await expect(manager.status()).resolves.toEqual({ currentVersion: "001", pending: [] });
    await manager.migrate();
    expect(database.statements.filter((statement) => statement === migration.up[0])).toHaveLength(
      1,
    );
    expect(database.statements).toContain(
      "SELECT pg_advisory_xact_lock(hashtext('pactmark:migrations'))",
    );
    expect(database.applied[0]?.migration_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("rejects unknown targets and malformed migration ordering before changing schema", async () => {
    const database = new MigrationDatabase();
    const manager = new PostgresMigrationManager(database, [migration]);
    await expect(manager.migrate("999")).rejects.toMatchObject({ code: "KAF_SCHEMA_INVALID" });
    expect(() => new PostgresMigrationManager(database, [migration, migration])).toThrow(
      expect.objectContaining({ code: "KAF_SCHEMA_INVALID" }),
    );
  });

  it("upgrades an empty 008 ledger through migrations 009, 010, and 011 exactly once", async () => {
    const database = new MigrationDatabase();
    const migrations = POSTGRES_MIGRATIONS.slice(-4);
    const manager = new PostgresMigrationManager(database, migrations);
    await manager.migrate("008");
    await expect(manager.status()).resolves.toEqual({
      currentVersion: "008",
      pending: ["009", "010", "011"],
    });
    await manager.migrate();
    await manager.migrate();
    await expect(manager.status()).resolves.toEqual({ currentVersion: "011", pending: [] });
    const effectResultMigration = migrations[1]!;
    const protectedReferenceMigration = migrations[2]!;
    const rowLevelSecurityMigration = migrations[3]!;
    expect(
      database.statements.filter((statement) => statement === effectResultMigration.up[0]),
    ).toHaveLength(1);
    expect(
      database.statements.filter((statement) => statement === protectedReferenceMigration.up[0]),
    ).toHaveLength(1);
    expect(
      database.statements.filter((statement) => statement === rowLevelSecurityMigration.up[0]),
    ).toHaveLength(1);
    expect(effectResultMigration.up[0]).not.toMatch(/(?:^|\n)\s*(?:ALTER|DROP|DELETE|UPDATE)\s/iu);
  });
});

describe("fenced leases", () => {
  it("binds acquisition to tenant/run, maps database time, and rejects stale renewal", async () => {
    const database = new LeaseDatabase();
    const store = new PostgresRunLeaseStore(database, {
      generateLeaseId: () => "lease-1",
    });
    const lease = await store.acquire("tenant-a", "run-1", "worker-1", 1_000);
    expect(lease).toMatchObject({
      tenantId: "tenant-a",
      runId: "run-1",
      leaseId: "lease-1",
      fencingToken: 1,
      state: "active",
    });
    expect(database.values[0]?.slice(0, 4)).toEqual(["tenant-a", "run-1", "lease-1", "worker-1"]);
    database.allowMutation = false;
    await expect(store.renew(lease!, 1_000)).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    await expect(store.release(lease!)).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
  });

  it("returns undefined while another live holder owns the tenant/run lease", async () => {
    const database = new LeaseDatabase();
    database.allowAcquire = false;
    const store = new PostgresRunLeaseStore(database, { generateLeaseId: () => "lease-2" });
    await expect(store.acquire("tenant-a", "run-1", "worker-2", 500)).resolves.toBeUndefined();
  });
});

class TransactionDatabase implements PostgresDatabase {
  readonly statements: string[] = [];
  released = false;

  async query<Row extends QueryResultRow>(): Promise<SqlResult<Row>> {
    await Promise.resolve();
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<PostgresClient> {
    await Promise.resolve();
    return {
      query: async <Row extends QueryResultRow>(text: string): Promise<SqlResult<Row>> => {
        await Promise.resolve();
        this.statements.push(text);
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        this.released = true;
      },
    };
  }
}

class MigrationDatabase implements PostgresDatabase {
  readonly statements: string[] = [];
  readonly applied: { version: string; migration_digest: string }[] = [];

  async query<Row extends QueryResultRow>(text: string): Promise<SqlResult<Row>> {
    await Promise.resolve();
    this.statements.push(text);
    if (text.startsWith("SELECT version")) {
      return { rows: [...this.applied] as unknown as Row[], rowCount: this.applied.length };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<PostgresClient> {
    await Promise.resolve();
    return {
      query: async <Row extends QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<SqlResult<Row>> => {
        await Promise.resolve();
        this.statements.push(text);
        if (text.startsWith("SELECT version")) {
          return { rows: [...this.applied] as unknown as Row[], rowCount: this.applied.length };
        }
        if (text.startsWith("INSERT INTO pactmark_schema_migrations")) {
          this.applied.push({
            version: String(values?.[0]),
            migration_digest: String(values?.[2]),
          });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
  }
}

class LeaseDatabase implements PostgresDatabase {
  readonly values: (readonly unknown[])[] = [];
  allowAcquire = true;
  allowMutation = true;

  async query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    await Promise.resolve();
    if (values !== undefined) this.values.push(values);
    if (text.includes("INSERT INTO pactmark_run_leases")) {
      const rows = this.allowAcquire ? [this.row(values)] : [];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    }
    if (text.includes("UPDATE pactmark_run_leases SET expires_at")) {
      const rows = this.allowMutation ? [this.row(values)] : [];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    }
    if (text.includes("UPDATE pactmark_run_leases SET state='released'")) {
      return { rows: [], rowCount: this.allowMutation ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<PostgresClient> {
    await Promise.resolve();
    throw new Error("not used by this test");
  }

  private row(values?: readonly unknown[]) {
    return {
      tenant_id: String(values?.[0]),
      run_id: String(values?.[1]),
      lease_id: safeString(values?.[2], "lease-1"),
      holder_id: safeString(values?.[3], "worker-1"),
      fencing_token: 1,
      acquired_at: instantDate,
      expires_at: new Date(instantDate.getTime() + 1_000),
      state: "active",
    };
  }
}

const instantDate = new Date("2026-08-03T10:00:00.000Z");

function safeString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
