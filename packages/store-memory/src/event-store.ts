import {
  createRunProjection,
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

import {
  createMemoryStorageSecurityProfile,
  MEMORY_STORE_CAPABILITIES,
  MemoryStorageGuard,
  type MemoryStorageProfileOptions,
} from "./config.js";
import { cloneJson, conflict, recordKey, sameJson } from "./internal.js";
import type { MemoryRunLeaseStore } from "./lease-store.js";

type EventRecord = Readonly<{ key: string; event: RunEvent }>;
type EventStoreSnapshot = Readonly<{
  streams: Map<string, RunEvent[]>;
  eventsById: Map<string, EventRecord>;
  projections: Map<string, RunProjection>;
}>;

export class MemoryEventStore implements EventStore {
  readonly capabilities: RuntimeCapabilities = MEMORY_STORE_CAPABILITIES;
  readonly securityProfile: StorageSecurityProfile;
  readonly #streams = new Map<string, RunEvent[]>();
  readonly #eventsById = new Map<string, EventRecord>();
  readonly #projections = new Map<string, RunProjection>();
  readonly #leaseStore: MemoryRunLeaseStore | undefined;
  readonly #guard: MemoryStorageGuard;

  constructor(
    options: MemoryStorageProfileOptions & {
      readonly leaseStore?: MemoryRunLeaseStore;
      readonly securityProfile?: StorageSecurityProfile;
    } = {},
  ) {
    this.#leaseStore = options.leaseStore;
    this.securityProfile = options.securityProfile ?? createMemoryStorageSecurityProfile(options);
    this.#guard = new MemoryStorageGuard(this.securityProfile);
  }

  async append(
    input: RunEvent,
    expectedSequence: number,
  ): Promise<{ sequence: number; replayed: boolean }> {
    await Promise.resolve();
    return this.appendSynchronous(input, expectedSequence);
  }

  async appendFenced(
    input: RunEvent,
    expectedSequence: number,
    lease: RunLease,
  ): Promise<{ sequence: number; replayed: boolean }> {
    await Promise.resolve();
    if (this.#leaseStore === undefined) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: { requiredCapability: "fenced_event_append" },
      });
    }
    this.#leaseStore.assertActive(lease);
    const event = RunEventSchema.parse(input);
    this.#guard.assertRoutingAllowed(event.tenantId, event.dataClass);
    if (event.tenantId !== lease.tenantId || event.runId !== lease.runId) {
      throw new KafError("KAF_RUNTIME_EVENT_BINDING");
    }
    return this.appendSynchronous(event, expectedSequence);
  }

  async *read(tenantId: string, runId: string, afterSequence = 0): AsyncIterable<RunEvent> {
    await Promise.resolve();
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "afterSequence", issue: "nonnegative_integer" },
      });
    }
    const snapshot = [...(this.#streams.get(recordKey(tenantId, runId)) ?? [])];
    for (const event of snapshot) {
      if (event.sequence > afterSequence) yield cloneJson(event);
    }
  }

  async getProjection(tenantId: string, runId: string): Promise<RunProjection | undefined> {
    await Promise.resolve();
    const projection = this.#projections.get(recordKey(tenantId, runId));
    return projection === undefined ? undefined : cloneJson(projection);
  }

  dropProjection(tenantId: string, runId: string): void {
    this.#projections.delete(recordKey(tenantId, runId));
  }

  rebuildProjection(tenantId: string, runId: string): RunProjection | undefined {
    const key = recordKey(tenantId, runId);
    const stream = this.#streams.get(key);
    if (stream === undefined || stream.length === 0) return undefined;
    const first = stream[0];
    if (first === undefined) return undefined;
    let projection = initialProjection(first);
    for (const event of stream) projection = reduceRunEvent(projection, event);
    this.#projections.set(key, projection);
    return cloneJson(projection);
  }

  transactionSnapshot(): EventStoreSnapshot {
    return {
      streams: structuredClone(this.#streams),
      eventsById: structuredClone(this.#eventsById),
      projections: structuredClone(this.#projections),
    };
  }

  transactionRestore(snapshot: EventStoreSnapshot): void {
    replaceMap(this.#streams, snapshot.streams);
    replaceMap(this.#eventsById, snapshot.eventsById);
    replaceMap(this.#projections, snapshot.projections);
  }

  private appendSynchronous(
    input: RunEvent,
    expectedSequence: number,
  ): { sequence: number; replayed: boolean } {
    const event = RunEventSchema.parse(input);
    this.#guard.assertRoutingAllowed(event.tenantId, event.dataClass);
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: { path: "expectedSequence", issue: "nonnegative_integer" },
      });
    }
    const key = recordKey(event.tenantId, event.runId);
    const duplicate = this.#eventsById.get(event.eventId);
    if (duplicate !== undefined) {
      if (duplicate.key === key && sameJson(duplicate.event, event)) {
        return { sequence: duplicate.event.sequence, replayed: true };
      }
      conflict("event_id_reused");
    }
    const stream = this.#streams.get(key) ?? [];
    if (stream.length !== expectedSequence || event.sequence !== expectedSequence + 1) {
      conflict("event_sequence");
    }
    const previous = this.#projections.get(key);
    let next: RunProjection;
    if (previous === undefined) {
      if (stream.length !== 0) {
        throw new KafError("KAF_STORAGE_NOT_FOUND", {
          details: { reason: "projection_missing_rebuild_required" },
        });
      }
      next = reduceRunEvent(initialProjection(event), event);
    } else {
      next = reduceRunEvent(previous, event);
    }
    const storedEvent = cloneJson(event);
    stream.push(storedEvent);
    this.#streams.set(key, stream);
    this.#eventsById.set(event.eventId, { key, event: storedEvent });
    this.#projections.set(key, next);
    return { sequence: event.sequence, replayed: false };
  }
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
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
