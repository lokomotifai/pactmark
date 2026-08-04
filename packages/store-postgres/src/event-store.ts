import {
  createRunProjection,
  digestCanonicalJson,
  KafError,
  reduceRunEvent,
  RunEventSchema,
  RunProjectionSchema,
  type EventStore,
  type RunEvent,
  type RunLease,
  type RunProjection,
  type RuntimeCapabilities,
  type StorageSecurityProfile,
} from "@pactmark/core";
import { POSTGRES_STORE_CAPABILITIES, PostgresStorageGuard } from "./config.js";
import type { PostgresDatabase } from "./database.js";
import { withTransaction } from "./database.js";
import { assertNonempty, assertNonnegative, conflict, parseJsonColumn } from "./internal.js";
import type { PostgresRunLeaseStore } from "./lease-store.js";

type EventRow = { event_json: unknown; canonical_digest: string; sequence: string | number };
type ProjectionRow = { projection_json: unknown; last_sequence: string | number };

export class PostgresEventStore implements EventStore {
  readonly capabilities: RuntimeCapabilities = POSTGRES_STORE_CAPABILITIES;
  readonly #guard: PostgresStorageGuard;
  constructor(
    readonly database: PostgresDatabase,
    readonly securityProfile: StorageSecurityProfile,
    readonly leaseStore?: PostgresRunLeaseStore,
  ) {
    this.#guard = new PostgresStorageGuard(securityProfile);
  }

  append(
    input: RunEvent,
    expectedSequence: number,
  ): Promise<{ sequence: number; replayed: boolean }> {
    return this.appendInternal(input, expectedSequence);
  }

  appendFenced(
    input: RunEvent,
    expectedSequence: number,
    lease: RunLease,
  ): Promise<{ sequence: number; replayed: boolean }> {
    if (this.leaseStore === undefined) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { requiredCapability: "fenced_event_append" },
      });
    }
    if (input.tenantId !== lease.tenantId || input.runId !== lease.runId) {
      throw new KafError("KAF_RUNTIME_EVENT_BINDING");
    }
    return this.appendInternal(input, expectedSequence, lease);
  }

  private async appendInternal(
    input: RunEvent,
    expectedSequence: number,
    lease?: RunLease,
  ): Promise<{ sequence: number; replayed: boolean }> {
    const event = RunEventSchema.parse(input);
    assertNonnegative(expectedSequence, "expectedSequence");
    this.#guard.assertRoutingAllowed(event.tenantId, event.dataClass);
    try {
      return await withTransaction(this.database, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          digestCanonicalJson({ tenantId: event.tenantId, runId: event.runId }),
        ]);
        if (lease !== undefined) await this.leaseStore?.assertActive(client, lease);
        const canonicalDigest = digestCanonicalJson(event);
        const duplicate = await client.query<EventRow>(
          "SELECT event_json, canonical_digest, sequence FROM pactmark_run_events WHERE tenant_id=$1 AND event_id=$2",
          [event.tenantId, event.eventId],
        );
        const duplicateRow = duplicate.rows[0];
        if (duplicateRow !== undefined) {
          const storedEvent = RunEventSchema.parse(parseJsonColumn(duplicateRow.event_json));
          if (digestCanonicalJson(storedEvent) !== duplicateRow.canonical_digest) {
            conflict("stored_event_payload_changed");
          }
          if (duplicateRow.canonical_digest === canonicalDigest)
            return { sequence: Number(duplicateRow.sequence), replayed: true };
          conflict("event_id_reused");
        }
        const tail = await client.query<{ sequence: string | number }>(
          "SELECT sequence FROM pactmark_run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence DESC LIMIT 1",
          [event.tenantId, event.runId],
        );
        const actual = Number(tail.rows[0]?.sequence ?? 0);
        if (actual !== expectedSequence || event.sequence !== expectedSequence + 1)
          conflict("event_sequence");
        const stored = await client.query<ProjectionRow>(
          "SELECT projection_json, last_sequence FROM pactmark_run_projections WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE",
          [event.tenantId, event.runId],
        );
        const row = stored.rows[0];
        if (row === undefined && actual !== 0) {
          throw new KafError("KAF_STORAGE_NOT_FOUND", {
            details: { reason: "projection_missing_rebuild_required" },
          });
        }
        const previous =
          row === undefined
            ? initialProjection(event)
            : RunProjectionSchema.parse(parseJsonColumn(row.projection_json));
        if (row !== undefined && previous.lastSequence !== Number(row.last_sequence)) {
          conflict("projection_sequence_changed");
        }
        const next = reduceRunEvent(previous, event);
        await client.query(
          `INSERT INTO pactmark_run_events
        (tenant_id,run_id,sequence,event_id,event_json,canonical_digest,occurred_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz)`,
          [
            event.tenantId,
            event.runId,
            event.sequence,
            event.eventId,
            JSON.stringify(event),
            canonicalDigest,
            event.occurredAt,
          ],
        );
        await client.query(
          `INSERT INTO pactmark_run_projections
        (tenant_id,run_id,last_sequence,projection_json,updated_at) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
        ON CONFLICT (tenant_id,run_id) DO UPDATE SET last_sequence=EXCLUDED.last_sequence,
          projection_json=EXCLUDED.projection_json, updated_at=EXCLUDED.updated_at`,
          [event.tenantId, event.runId, event.sequence, JSON.stringify(next), event.occurredAt],
        );
        return { sequence: event.sequence, replayed: false };
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) conflict("database_unique_constraint");
      throw error;
    }
  }

  async *read(tenantId: string, runId: string, afterSequence = 0): AsyncIterable<RunEvent> {
    assertNonempty(tenantId, "tenantId");
    assertNonempty(runId, "runId");
    this.#guard.assertTenantAllowed(tenantId);
    assertNonnegative(afterSequence, "afterSequence");
    const result = await this.database.query<EventRow>(
      "SELECT event_json, canonical_digest, sequence FROM pactmark_run_events WHERE tenant_id=$1 AND run_id=$2 AND sequence>$3 ORDER BY sequence",
      [tenantId, runId, afterSequence],
    );
    for (const row of result.rows) {
      const event = RunEventSchema.parse(parseJsonColumn(row.event_json));
      if (
        event.tenantId !== tenantId ||
        event.runId !== runId ||
        event.sequence !== Number(row.sequence)
      ) {
        conflict("event_binding_changed");
      }
      if (digestCanonicalJson(event) !== row.canonical_digest) conflict("event_payload_changed");
      yield event;
    }
  }

  async getProjection(tenantId: string, runId: string): Promise<RunProjection | undefined> {
    assertNonempty(tenantId, "tenantId");
    assertNonempty(runId, "runId");
    this.#guard.assertTenantAllowed(tenantId);
    const result = await this.database.query<ProjectionRow>(
      "SELECT projection_json,last_sequence FROM pactmark_run_projections WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, runId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const projection = RunProjectionSchema.parse(parseJsonColumn(row.projection_json));
    if (
      projection.tenantId !== tenantId ||
      projection.runId !== runId ||
      projection.lastSequence !== Number(row.last_sequence)
    ) {
      conflict("projection_binding_changed");
    }
    return projection;
  }

  async dropProjection(tenantId: string, runId: string): Promise<void> {
    assertNonempty(tenantId, "tenantId");
    assertNonempty(runId, "runId");
    this.#guard.assertTenantAllowed(tenantId);
    await this.database.query(
      "DELETE FROM pactmark_run_projections WHERE tenant_id=$1 AND run_id=$2",
      [tenantId, runId],
    );
  }

  async rebuildProjection(tenantId: string, runId: string): Promise<RunProjection | undefined> {
    assertNonempty(tenantId, "tenantId");
    assertNonempty(runId, "runId");
    this.#guard.assertTenantAllowed(tenantId);
    return withTransaction(this.database, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        digestCanonicalJson({ tenantId, runId }),
      ]);
      const events = await client.query<EventRow>(
        "SELECT event_json,canonical_digest,sequence FROM pactmark_run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY sequence",
        [tenantId, runId],
      );
      const parsed = events.rows.map((row) => {
        const event = RunEventSchema.parse(parseJsonColumn(row.event_json));
        if (
          event.tenantId !== tenantId ||
          event.runId !== runId ||
          event.sequence !== Number(row.sequence)
        ) {
          conflict("event_binding_changed");
        }
        if (digestCanonicalJson(event) !== row.canonical_digest) conflict("event_payload_changed");
        return event;
      });
      const first = parsed[0];
      if (first === undefined) return undefined;
      let projection = initialProjection(first);
      for (const event of parsed) projection = reduceRunEvent(projection, event);
      await client.query(
        `INSERT INTO pactmark_run_projections
        (tenant_id,run_id,last_sequence,projection_json,updated_at) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
        ON CONFLICT (tenant_id,run_id) DO UPDATE SET last_sequence=EXCLUDED.last_sequence,
          projection_json=EXCLUDED.projection_json,updated_at=EXCLUDED.updated_at`,
        [
          tenantId,
          runId,
          projection.lastSequence,
          JSON.stringify(projection),
          projection.updatedAt,
        ],
      );
      return projection;
    });
  }
}

function initialProjection(event: RunEvent): RunProjection {
  if (event.eventType !== "RunAccepted" || event.sequence !== 1) {
    throw new KafError("KAF_RUNTIME_EVENT_SEQUENCE", {
      details: { expected: 1, received: event.sequence },
    });
  }
  return RunProjectionSchema.parse(
    createRunProjection({
      schemaVersion: "1",
      runId: event.runId,
      tenantId: event.tenantId,
      workOrderId: event.payload.workOrderId,
      workOrderBindingDigest: event.payload.workOrderBindingDigest,
      executionDefinition: event.executionDefinition,
      executionDefinitionDigest: event.executionDefinitionDigest,
      status: "created",
      createdAt: event.occurredAt,
      updatedAt: event.occurredAt,
      dataClass: event.dataClass,
      correlationId: event.correlationId,
    }),
  );
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
