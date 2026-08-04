import { digestCanonicalJson, type RunEvent } from "@pactmark/core";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createPostgresStorageSecurityProfile } from "../src/config.js";
import type { PostgresClient, PostgresDatabase, SqlResult } from "../src/database.js";
import { PostgresEventStore } from "../src/event-store.js";
import { PostgresProjectionRebuilder } from "../src/projection-rebuilder.js";
import { planningStarted, runAccepted } from "./fixtures.js";

describe("PostgresEventStore", () => {
  it("deduplicates exact event replays and rejects changed event ID content", async () => {
    const database = new EventDatabase();
    const store = new PostgresEventStore(database, createPostgresStorageSecurityProfile());
    await expect(store.append(runAccepted(), 0)).resolves.toEqual({ sequence: 1, replayed: false });
    await expect(store.append(runAccepted(), 0)).resolves.toEqual({ sequence: 1, replayed: true });
    await expect(store.append(runAccepted({ correlationId: "changed" }), 0)).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    await expect(
      store.append(runAccepted({ tenantId: "tenant-b", runId: "run-b" }), 0),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    expect(database.events).toHaveLength(1);
  });

  it("enforces optimistic sequence, tenant-scoped reads, and canonical projection rebuild", async () => {
    const database = new EventDatabase();
    const store = new PostgresEventStore(database, createPostgresStorageSecurityProfile());
    await store.append(runAccepted(), 0);
    await store.append(planningStarted(), 1);
    await expect(
      store.append({ ...planningStarted(), eventId: "event-3" }, 1),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });

    expect(await collect(store.read("tenant-b", "run-1"))).toEqual([]);
    expect(await collect(store.read("tenant-a", "run-1"))).toHaveLength(2);
    const before = await store.getProjection("tenant-a", "run-1");
    await store.dropProjection("tenant-a", "run-1");
    await expect(store.getProjection("tenant-a", "run-1")).resolves.toBeUndefined();
    const rebuilt = await store.rebuildProjection("tenant-a", "run-1");
    expect(digestCanonicalJson(rebuilt)).toBe(digestCanonicalJson(before));
    const operationalApi = new PostgresProjectionRebuilder(store);
    const rebuiltMany = await operationalApi.rebuildMany("tenant-a", ["run-1", "run-1"]);
    expect(rebuiltMany.size).toBe(1);
    expect(digestCanonicalJson(rebuiltMany.get("run-1"))).toBe(digestCanonicalJson(before));
  });

  it("fails closed when persisted event content no longer matches its digest", async () => {
    const database = new EventDatabase();
    const store = new PostgresEventStore(database, createPostgresStorageSecurityProfile());
    await store.append(runAccepted(), 0);
    database.events[0]!.canonical_digest = digestCanonicalJson({ tampered: true });
    await expect(collect(store.read("tenant-a", "run-1"))).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
  });
});

async function collect(iterable: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const output: RunEvent[] = [];
  for await (const event of iterable) output.push(event);
  return output;
}

type StoredEvent = {
  tenant_id: string;
  run_id: string;
  sequence: number;
  event_id: string;
  event_json: unknown;
  canonical_digest: string;
};

type StoredProjection = {
  tenant_id: string;
  run_id: string;
  last_sequence: number;
  projection_json: unknown;
};

class EventDatabase implements PostgresDatabase {
  readonly events: StoredEvent[] = [];
  readonly projections = new Map<string, StoredProjection>();

  async query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    await Promise.resolve();
    return this.execute<Row>(text, values);
  }

  async connect(): Promise<PostgresClient> {
    await Promise.resolve();
    return {
      query: async <Row extends QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<SqlResult<Row>> => {
        await Promise.resolve();
        return this.execute<Row>(text, values);
      },
      release: () => undefined,
    };
  }

  private execute<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): SqlResult<Row> {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text) || text.includes("pg_advisory_xact_lock")) {
      return empty();
    }
    const tenantId = String(values?.[0]);
    const runId = String(values?.[1]);
    if (text.includes("FROM pactmark_run_events WHERE tenant_id=$1 AND event_id=$2")) {
      return rows(
        this.events.filter((event) => event.tenant_id === tenantId && event.event_id === runId),
      );
    }
    if (text.includes("ORDER BY sequence DESC LIMIT 1")) {
      const tail = this.stream(tenantId, runId).at(-1);
      return rows(tail === undefined ? [] : [{ sequence: tail.sequence }]);
    }
    if (text.includes("FROM pactmark_run_projections") && text.includes("FOR UPDATE")) {
      const projection = this.projections.get(key(tenantId, runId));
      return rows(projection === undefined ? [] : [projection]);
    }
    if (text.includes("INSERT INTO pactmark_run_events")) {
      if (this.events.some((event) => event.event_id === String(values?.[3]))) {
        throw Object.assign(new Error("duplicate event ID"), { code: "23505" });
      }
      this.events.push({
        tenant_id: tenantId,
        run_id: runId,
        sequence: Number(values?.[2]),
        event_id: String(values?.[3]),
        event_json: JSON.parse(String(values?.[4])),
        canonical_digest: String(values?.[5]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO pactmark_run_projections")) {
      this.projections.set(key(tenantId, runId), {
        tenant_id: tenantId,
        run_id: runId,
        last_sequence: Number(values?.[2]),
        projection_json: JSON.parse(String(values?.[3])),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("sequence>$3")) {
      return rows(
        this.stream(tenantId, runId).filter(({ sequence }) => sequence > Number(values?.[2])),
      );
    }
    if (text.includes("FROM pactmark_run_events") && text.includes("ORDER BY sequence")) {
      return rows(this.stream(tenantId, runId));
    }
    if (text.includes("SELECT projection_json,last_sequence")) {
      const projection = this.projections.get(key(tenantId, runId));
      return rows(projection === undefined ? [] : [projection]);
    }
    if (text.includes("DELETE FROM pactmark_run_projections")) {
      const deleted = this.projections.delete(key(tenantId, runId));
      return { rows: [], rowCount: deleted ? 1 : 0 };
    }
    return empty();

    function rows(valuesToReturn: readonly unknown[]): SqlResult<Row> {
      return { rows: valuesToReturn as Row[], rowCount: valuesToReturn.length };
    }
    function empty(): SqlResult<Row> {
      return { rows: [], rowCount: 0 };
    }
  }

  private stream(tenantId: string, runId: string): StoredEvent[] {
    return this.events
      .filter((event) => event.tenant_id === tenantId && event.run_id === runId)
      .toSorted((left, right) => left.sequence - right.sequence);
  }
}

function key(tenantId: string, runId: string): string {
  return `${tenantId}\u0000${runId}`;
}
