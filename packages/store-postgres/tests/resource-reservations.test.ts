import {
  digestBytes,
  digestCanonicalJson,
  type ActiveExecutionReservation,
  type AdmissionRequest,
  type AdmissionReservation,
  type CircuitBreakerState,
  type ModelCallReservation,
  type QuotaLimit,
  type RunCommandTransaction,
} from "@pactmark/core";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type { PostgresClient, PostgresDatabase, SqlResult } from "../src/database.js";
import {
  PostgresActiveExecutionReservationStore,
  PostgresCircuitBreakerStore,
  PostgresModelCallReservationServices,
  PostgresModelCallReservationStore,
  PostgresQuotaStore,
  putActiveExecutionReservation,
  putModelCallReservation,
  reserveAdmission,
} from "../src/resource-reservations.js";

const now = "2026-08-03T10:00:00.000Z";
const later = "2026-08-03T10:00:01.000Z";
const expires = "2026-08-03T10:01:00.000Z";
const commandId = "kafcmd_1760000000000_00000000000000000000000000000001";
const digest = (value: string) => digestBytes(new TextEncoder().encode(value));

type QueryHandler = (
  text: string,
  values: readonly unknown[] | undefined,
) => SqlResult<QueryResultRow> | Promise<SqlResult<QueryResultRow>>;

class TestDatabase implements PostgresDatabase, PostgresClient {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  released = 0;

  constructor(readonly handler: QueryHandler) {}

  async query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>> {
    this.queries.push({ text, ...(values === undefined ? {} : { values }) });
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    return (await this.handler(text, values)) as SqlResult<Row>;
  }

  connect(): Promise<PostgresClient> {
    return Promise.resolve(this);
  }

  release(): void {
    this.released += 1;
  }
}

function rows(...values: QueryResultRow[]): SqlResult<QueryResultRow> {
  return { rows: values, rowCount: values.length };
}

function changedRows(rowCount = 1): SqlResult<QueryResultRow> {
  return { rows: [], rowCount };
}

function admissionRequest(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    schemaVersion: "1",
    tenant: { id: "tenant-a" },
    principal: { type: "user", id: "user-1" },
    commandId,
    category: "request_start",
    resourceKey: "agent:help",
    amount: 1,
    leaseDurationMs: 60_000,
    ...overrides,
  };
}

function admissionReservation(overrides: Partial<AdmissionReservation> = {}): AdmissionReservation {
  return {
    schemaVersion: "1",
    id: "admission:1",
    tenant: { id: "tenant-a" },
    principal: { type: "user", id: "user-1" },
    commandId,
    category: "request_start",
    resourceKey: "agent:help",
    amount: 1,
    state: "reserved",
    fencingToken: 1,
    reservedAtServerTime: now,
    leaseExpiresAt: expires,
    ...overrides,
  };
}

const tenantRequestLimit: QuotaLimit = {
  schemaVersion: "1",
  scope: "tenant",
  metric: "request_start",
  resourceKey: "*",
  maximum: 2,
  retryAfterSeconds: 9,
};

function activeReservation(
  overrides: Partial<ActiveExecutionReservation> = {},
): ActiveExecutionReservation {
  return {
    schemaVersion: "1",
    id: "active-1",
    tenant: { id: "tenant-a" },
    runId: "run-1",
    stepId: "step-1",
    boundary: "model",
    boundaryKey: "model-1",
    leaseId: "lease-1",
    fencingToken: 2,
    startedAtServerTime: now,
    maxChargeMs: 1_000,
    state: "reserved",
    expiresAt: expires,
    ...overrides,
  };
}

function settledActive(
  overrides: Partial<ActiveExecutionReservation> = {},
): ActiveExecutionReservation {
  return activeReservation({
    state: "settled",
    settledChargeMs: 400,
    refundedMs: 600,
    settledAtServerTime: later,
    ...overrides,
  });
}

function modelReservation(overrides: Partial<ModelCallReservation> = {}): ModelCallReservation {
  return {
    schemaVersion: "1",
    reservationId: "model-1",
    tenantId: "tenant-a",
    runId: "run-1",
    stepId: "step-1",
    attempt: 1,
    workOrderBindingDigest: digest("work"),
    agentDefinitionDigest: digest("agent"),
    modelSecurityProfileDigest: digest("security"),
    modelResourceProfileDigest: digest("resource"),
    modelAdapterRegistrationDigest: digest("adapter"),
    inputBytes: 100,
    inputTokenUpperBound: 20,
    outputTokenMaximum: 30,
    outputBytesMaximum: 200,
    status: "accepted",
    expiresAt: expires,
    createdAt: now,
    ...overrides,
  };
}

function modelSettlement(overrides: Partial<ModelCallReservation> = {}): ModelCallReservation {
  return modelReservation({
    status: "settled",
    settlement: {
      schemaVersion: "1",
      inputBytes: 100,
      inputTokenLowerBound: 10,
      outputBytes: 50,
      outputTokenLowerBound: 5,
      chargedTokens: 15,
      chargedIoBytes: 150,
      settledAt: later,
    },
    ...overrides,
  });
}

function circuitState(overrides: Partial<CircuitBreakerState> = {}): CircuitBreakerState {
  return {
    schemaVersion: "1",
    tenantId: "tenant-a",
    providerKey: "provider-a",
    state: "closed",
    failureCount: 0,
    updatedAt: now,
    ...overrides,
  };
}

describe("Postgres admission and quota reservations", () => {
  it("reserves with server time, tenant scope, wildcard limit, and no command id", async () => {
    const { commandId: _commandId, ...request } = admissionRequest();
    void _commandId;
    const database = new TestDatabase((text) => {
      if (text.includes("clock_timestamp() AS now")) return rows({ now });
      if (text.includes("SUM(amount)")) return rows({ used: "1" });
      if (text.includes("nextval")) return rows({ id: "7" });
      return changedRows();
    });
    await expect(
      reserveAdmission(database, "tenant-a", request, [tenantRequestLimit]),
    ).resolves.toEqual(
      expect.objectContaining({ id: "admission:7", state: "reserved", leaseExpiresAt: expires }),
    );
    expect(
      database.queries.find((query) => query.text.includes("pg_advisory"))?.values?.[0],
    ).toContain('"tenant"');
    expect(database.queries.some((query) => query.text.includes("INSERT INTO"))).toBe(true);
  });

  it("rejects cross-tenant, over-limit, changed replay, and missing generated ids", async () => {
    await expect(
      reserveAdmission(new TestDatabase(() => changedRows()), "tenant-b", admissionRequest(), []),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });

    const denied = new TestDatabase((text) => {
      if (text.includes("FOR UPDATE")) return rows();
      if (text.includes("clock_timestamp")) return rows({ now });
      if (text.includes("SUM(amount)")) return rows({ used: 2 });
      return changedRows();
    });
    await expect(
      reserveAdmission(denied, "tenant-a", admissionRequest(), [tenantRequestLimit]),
    ).rejects.toMatchObject({ code: "KAF_ADMISSION_DENIED" });

    const changedReplay = new TestDatabase((text) =>
      text.includes("FOR UPDATE")
        ? rows({
            request_digest: digest("different"),
            reservation_json: JSON.stringify(admissionReservation()),
          })
        : changedRows(),
    );
    await expect(
      reserveAdmission(changedReplay, "tenant-a", admissionRequest(), []),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });

    const missingId = new TestDatabase((text) => {
      if (text.includes("FOR UPDATE")) return rows();
      if (text.includes("clock_timestamp")) return rows({ now });
      if (text.includes("SUM(amount)")) return rows({ used: 0 });
      if (text.includes("nextval")) return rows();
      return changedRows();
    });
    await expect(
      reserveAdmission(missingId, "tenant-a", admissionRequest(), []),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
  });

  it("replays exactly and exposes admitted/denied decisions through the transaction wrapper", async () => {
    const request = admissionRequest();
    const prior = admissionReservation();
    const replayDatabase = new TestDatabase((text) =>
      text.includes("FOR UPDATE")
        ? rows({
            request_digest: digestCanonicalJson(request),
            reservation_json: JSON.stringify(prior),
          })
        : changedRows(),
    );
    await expect(reserveAdmission(replayDatabase, "tenant-a", request, [])).resolves.toEqual(prior);

    const admittedDatabase = new TestDatabase((text) => {
      if (text.includes("FOR UPDATE")) return rows();
      if (text.includes("clock_timestamp")) return rows({ now });
      if (text.includes("SUM(amount)")) return rows({ used: 0 });
      if (text.includes("nextval")) return rows({ id: 1 });
      return changedRows();
    });
    await expect(new PostgresQuotaStore(admittedDatabase).reserve(request)).resolves.toMatchObject({
      admitted: true,
    });

    const deniedDatabase = new TestDatabase((text) => {
      if (text.includes("FOR UPDATE")) return rows();
      if (text.includes("clock_timestamp")) return rows({ now });
      if (text.includes("SUM(amount)")) return rows({ used: 2 });
      return changedRows();
    });
    await expect(
      new PostgresQuotaStore(deniedDatabase, [tenantRequestLimit]).reserve(request),
    ).resolves.toEqual({ admitted: false, code: "KAF_ADMISSION_DENIED", retryAfterSeconds: 9 });
    expect(admittedDatabase.released).toBe(1);
    expect(deniedDatabase.queries.some((query) => query.text === "COMMIT")).toBe(true);
  });

  it("releases exactly once, fences conflicts, and reconciles expiry", async () => {
    const released = admissionReservation({ state: "released", releasedAt: later });
    const exact = new PostgresQuotaStore(
      new TestDatabase((text) =>
        text.includes("SELECT reservation_json")
          ? rows({ reservation_json: JSON.stringify(released) })
          : changedRows(),
      ),
    );
    await expect(exact.release("tenant-a", released.id, 1, later)).resolves.toBeUndefined();

    for (const [prior, token, at] of [
      [undefined, 1, later],
      [admissionReservation(), 2, later],
      [released, 1, expires],
      [admissionReservation({ state: "expired" }), 1, later],
    ] as const) {
      const store = new PostgresQuotaStore(
        new TestDatabase((text) =>
          text.includes("SELECT reservation_json") && prior !== undefined
            ? rows({ reservation_json: JSON.stringify(prior) })
            : changedRows(0),
        ),
      );
      await expect(store.release("tenant-a", "admission:1", token, at)).rejects.toMatchObject({
        code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
      });
    }

    const updateDatabase = new TestDatabase((text) =>
      text.includes("SELECT reservation_json")
        ? rows({ reservation_json: JSON.stringify(admissionReservation()) })
        : changedRows(),
    );
    await new PostgresQuotaStore(updateDatabase).release("tenant-a", "admission:1", 1, later);
    expect(
      updateDatabase.queries.some((query) => query.text.includes("SET state='released'")),
    ).toBe(true);

    const reconcileDatabase = new TestDatabase(() => changedRows(3));
    await expect(new PostgresQuotaStore(reconcileDatabase).reconcileExpired(later)).resolves.toBe(
      3,
    );
  });
});

describe("Postgres active-execution reservations", () => {
  it("inserts, replays, settles, and rejects invalid identity or transitions", async () => {
    const reserved = activeReservation();
    const activeDatabase = (
      prior?: ActiveExecutionReservation,
      databaseNow = now,
      used: string | number = 0,
    ) =>
      new TestDatabase((text) => {
        if (text.includes("clock_timestamp() AS now")) return rows({ now: databaseNow });
        if (text.includes("COALESCE(SUM")) return rows({ used });
        if (text.includes("SELECT reservation_json")) {
          return prior === undefined ? rows() : rows({ reservation_json: JSON.stringify(prior) });
        }
        return changedRows();
      });
    const inserted = activeDatabase();
    await expect(
      putActiveExecutionReservation(inserted, "tenant-a", reserved, 1_000),
    ).resolves.toEqual(
      activeReservation({
        expiresAt: "2026-08-03T10:00:01.000Z",
      }),
    );
    expect(inserted.queries.some((query) => query.text.includes("INSERT INTO"))).toBe(true);

    await expect(
      putActiveExecutionReservation(inserted, "tenant-b", reserved, 1_000),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      putActiveExecutionReservation(activeDatabase(), "tenant-a", settledActive(), 1_000),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });

    await expect(
      putActiveExecutionReservation(activeDatabase(reserved), "tenant-a", reserved, 1_000),
    ).resolves.toEqual(reserved);
    await expect(
      putActiveExecutionReservation(
        activeDatabase(reserved),
        "tenant-a",
        activeReservation({ leaseId: "changed" }),
        1_000,
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      putActiveExecutionReservation(
        activeDatabase(settledActive()),
        "tenant-a",
        settledActive({ settledChargeMs: 500, refundedMs: 500 }),
        1_000,
      ),
    ).resolves.toEqual(settledActive());

    const update = activeDatabase(reserved, later);
    await expect(
      putActiveExecutionReservation(update, "tenant-a", settledActive(), 1_000),
    ).resolves.toEqual(settledActive({ settledChargeMs: 1_000, refundedMs: 0 }));
    expect(update.queries.some((query) => query.text.includes("UPDATE pactmark"))).toBe(true);
  });

  it("uses database time and rejects invalid maximums, aggregate corruption, and budget debit", async () => {
    const reserved = activeReservation({ maxChargeMs: 100 });
    const database = (used: string | number, includeTime = true) =>
      new TestDatabase((text) => {
        if (text.includes("clock_timestamp() AS now")) {
          return includeTime ? rows({ now: later }) : rows();
        }
        if (text.includes("COALESCE(SUM")) return rows({ used });
        if (text.includes("SELECT reservation_json")) return rows();
        return changedRows();
      });
    await expect(
      putActiveExecutionReservation(database(0), "tenant-a", reserved, 0),
    ).rejects.toMatchObject({ code: "KAF_SCHEMA_INVALID" });
    await expect(
      putActiveExecutionReservation(database(0, false), "tenant-a", reserved, 100),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    for (const used of [-1, Number.MAX_SAFE_INTEGER + 1, 1]) {
      await expect(
        putActiveExecutionReservation(database(used), "tenant-a", reserved, 100),
      ).rejects.toMatchObject({ code: "KAF_RUNTIME_CAPABILITY_MISSING" });
    }

    const normalized = await putActiveExecutionReservation(database(0), "tenant-a", reserved, 100);
    expect(normalized).toMatchObject({
      startedAtServerTime: later,
      expiresAt: "2026-08-03T10:00:01.100Z",
    });
  });

  it("gets tenant-scoped rows and reconciles expired work at maximum charge", async () => {
    const reserved = activeReservation();
    const getDatabase = new TestDatabase((text, values) =>
      text.includes("SELECT reservation_json") && values?.[1] === reserved.id
        ? rows({ reservation_json: JSON.stringify(reserved) })
        : rows(),
    );
    const store = new PostgresActiveExecutionReservationStore(getDatabase);
    await expect(store.get("tenant-a", reserved.id)).resolves.toEqual(reserved);
    await expect(store.get("tenant-b", "missing")).resolves.toBeUndefined();

    let expiryScan = true;
    const reconcileDatabase = new TestDatabase((text) => {
      if (text.includes("state='reserved'") && expiryScan) {
        expiryScan = false;
        return { rows: [{ reservation_json: JSON.stringify(reserved) }], rowCount: 1 };
      }
      if (text.includes("SELECT reservation_json")) {
        return rows({ reservation_json: JSON.stringify(reserved) });
      }
      if (text.includes("clock_timestamp() AS now")) return rows({ now: later });
      return changedRows();
    });
    await expect(
      new PostgresActiveExecutionReservationStore(reconcileDatabase).reconcileExpired(later),
    ).resolves.toBe(1);
    const update = reconcileDatabase.queries.find((query) =>
      query.text.includes("UPDATE pactmark"),
    );
    expect(update?.values).toEqual(expect.arrayContaining(["closed_uncertain", 1_000, 0]));
  });
});

describe("Postgres model-call reservations", () => {
  it("inserts under token/io/cost limits and rejects denial, cross-tenant, and invalid starts", async () => {
    const costed = modelReservation({ maximumCallCostMinor: 40, currency: "USD" });
    const limits: QuotaLimit[] = [
      {
        schemaVersion: "1",
        scope: "tenant",
        metric: "model_tokens",
        resourceKey: "*",
        maximum: 100,
        retryAfterSeconds: 2,
      },
      {
        schemaVersion: "1",
        scope: "tenant",
        metric: "model_io_bytes",
        resourceKey: costed.modelSecurityProfileDigest,
        maximum: 1_000,
        retryAfterSeconds: 2,
      },
      {
        schemaVersion: "1",
        scope: "tenant",
        metric: "model_cost_minor",
        resourceKey: "*",
        maximum: 100,
        retryAfterSeconds: 2,
      },
    ];
    const inserted = new TestDatabase((text) => {
      if (text.includes("SELECT reservation_json")) return rows();
      if (text.includes("COALESCE(SUM")) return rows({ used: 0 });
      return changedRows();
    });
    await putModelCallReservation(inserted, "tenant-a", costed, limits);
    expect(inserted.queries.filter((query) => query.text.includes("COALESCE(SUM"))).toHaveLength(3);
    expect(inserted.queries.some((query) => query.text.includes("INSERT INTO"))).toBe(true);

    await expect(putModelCallReservation(inserted, "tenant-b", costed, [])).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    await expect(
      putModelCallReservation(inserted, "tenant-a", modelReservation({ status: "dispatched" }), []),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      putModelCallReservation(
        inserted,
        "tenant-a",
        modelReservation({ outputBytesMaximum: undefined }),
        [],
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });

    const denied = new TestDatabase((text) => {
      if (text.includes("SELECT reservation_json")) return rows();
      if (text.includes("COALESCE(SUM")) return rows({ used: 99 });
      return changedRows();
    });
    await expect(putModelCallReservation(denied, "tenant-a", costed, limits)).rejects.toMatchObject(
      { code: "KAF_ADMISSION_DENIED" },
    );
  });

  it("replays exactly, enforces binding/transitions/settlement ceilings, and updates", async () => {
    const reserved = modelReservation();
    const priorDatabase = (prior: ModelCallReservation) =>
      new TestDatabase((text) =>
        text.includes("SELECT reservation_json")
          ? rows({ reservation_json: JSON.stringify(prior) })
          : changedRows(),
      );
    await expect(
      putModelCallReservation(priorDatabase(reserved), "tenant-a", reserved, []),
    ).resolves.toBeUndefined();
    await expect(
      putModelCallReservation(
        priorDatabase(reserved),
        "tenant-a",
        modelReservation({ modelAdapterRegistrationDigest: digest("changed") }),
        [],
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      putModelCallReservation(
        priorDatabase(modelReservation({ status: "dispatched" })),
        "tenant-a",
        modelReservation({ status: "expired" }),
        [],
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      putModelCallReservation(
        priorDatabase(reserved),
        "tenant-a",
        modelSettlement({
          settlement: { ...modelSettlement().settlement!, chargedTokens: 51 },
        }),
        [],
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      putModelCallReservation(
        priorDatabase(reserved),
        "tenant-a",
        modelSettlement({
          settlement: { ...modelSettlement().settlement!, chargedIoBytes: 301 },
        }),
        [],
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });

    const costed = modelReservation({ maximumCallCostMinor: 40, currency: "USD" });
    await expect(
      putModelCallReservation(
        priorDatabase(costed),
        "tenant-a",
        modelSettlement({
          maximumCallCostMinor: 40,
          currency: "USD",
          settlement: {
            ...modelSettlement().settlement!,
            chargedCostMinor: 41,
            currency: "USD",
          },
        }),
        [],
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });

    const update = priorDatabase(reserved);
    await putModelCallReservation(
      update,
      "tenant-a",
      modelReservation({ status: "dispatched" }),
      [],
    );
    expect(update.queries.some((query) => query.text.includes("UPDATE pactmark"))).toBe(true);
  });

  it("gets, reconciles accepted/dispatched expiry, and derives conservative settlements", async () => {
    const accepted = modelReservation();
    const dispatched = modelReservation({
      reservationId: "model-2",
      attempt: 2,
      status: "dispatched",
    });
    const direct = new TestDatabase((text, values) =>
      text.includes("SELECT reservation_json") && values?.[0] === "tenant-a"
        ? rows({ reservation_json: JSON.stringify(accepted) })
        : rows(),
    );
    const store = new PostgresModelCallReservationStore(direct);
    await expect(store.get("tenant-a", "run-1", "step-1", 1)).resolves.toEqual(accepted);
    await expect(store.get("tenant-b", "run-1", "step-1", 1)).resolves.toBeUndefined();

    let scan = true;
    const reconcile = new TestDatabase((text, values) => {
      if (text.includes("state IN") && scan) {
        scan = false;
        return {
          rows: [
            { reservation_json: JSON.stringify(accepted) },
            { reservation_json: JSON.stringify(dispatched) },
          ],
          rowCount: 2,
        };
      }
      if (text.includes("SELECT reservation_json")) {
        const attempt = Number(values?.[3]);
        return rows({ reservation_json: JSON.stringify(attempt === 1 ? accepted : dispatched) });
      }
      return changedRows();
    });
    await expect(
      new PostgresModelCallReservationStore(reconcile).reconcileExpired(later),
    ).resolves.toBe(2);

    const writes: ModelCallReservation[] = [];
    const transaction = {
      putModelCallReservation: (value: ModelCallReservation) => {
        writes.push(value);
        return Promise.resolve();
      },
    } as unknown as RunCommandTransaction;
    const services = new PostgresModelCallReservationServices(() => later);
    await expect(services.reserve(transaction, dispatched)).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(services.markDispatched(transaction, accepted)).resolves.toMatchObject({
      status: "dispatched",
    });
    await expect(
      services.settle(transaction, accepted, {
        inputBytes: 100,
        inputTokenLowerBound: 10,
        outputBytes: 50,
        outputTokenLowerBound: 5,
      }),
    ).resolves.toMatchObject({
      status: "settled",
      settlement: { chargedTokens: 15, chargedIoBytes: 150 },
    });
    const costed = modelReservation({ maximumCallCostMinor: 40, currency: "USD" });
    await expect(
      services.settle(transaction, costed, {
        inputBytes: 100,
        inputTokenLowerBound: 10,
        outputBytes: 50,
        outputTokenLowerBound: 5,
        trustedProviderUsage: {
          inputTokens: 12,
          outputTokens: 8,
          callCostMinor: 30,
          currency: "USD",
        },
      }),
    ).resolves.toMatchObject({
      settlement: { chargedTokens: 20, chargedCostMinor: 30, currency: "USD" },
    });
    await expect(services.markUncertain(transaction, dispatched)).resolves.toMatchObject({
      status: "uncertain",
    });
    expect(writes).toHaveLength(5);
  });
});

describe("Postgres circuit breakers", () => {
  it("gets by tenant and performs CAS create, stale-race rejection, and fenced half-open updates", async () => {
    const closed = circuitState();
    const getDatabase = new TestDatabase((_text, values) =>
      values?.[0] === "tenant-a" ? rows({ state_json: JSON.stringify(closed) }) : rows(),
    );
    const getStore = new PostgresCircuitBreakerStore(getDatabase);
    await expect(getStore.get("tenant-a", "provider-a")).resolves.toEqual(closed);
    await expect(getStore.get("tenant-b", "provider-a")).resolves.toBeUndefined();

    const create = new PostgresCircuitBreakerStore(
      new TestDatabase((text) => (text.includes("SELECT state_json") ? rows() : changedRows())),
    );
    await expect(create.compareAndSet(undefined, closed)).resolves.toBe(true);

    const stale = new PostgresCircuitBreakerStore(
      new TestDatabase((text) =>
        text.includes("SELECT state_json")
          ? rows({ state_json: JSON.stringify(closed) })
          : changedRows(),
      ),
    );
    await expect(stale.compareAndSet(undefined, closed)).resolves.toBe(false);

    const priorHalfOpen = circuitState({
      state: "half_open",
      failureCount: 1,
      probeLeaseId: "probe-1",
      probeFencingToken: 3,
    });
    const halfOpenDatabase = new TestDatabase((text) =>
      text.includes("SELECT state_json")
        ? rows({ state_json: JSON.stringify(priorHalfOpen) })
        : changedRows(),
    );
    const halfOpen = new PostgresCircuitBreakerStore(halfOpenDatabase);
    await expect(
      halfOpen.compareAndSet(priorHalfOpen, { ...priorHalfOpen, updatedAt: later }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      halfOpen.compareAndSet(priorHalfOpen, {
        ...priorHalfOpen,
        probeLeaseId: "probe-2",
        probeFencingToken: 4,
        updatedAt: later,
      }),
    ).resolves.toBe(true);
    expect(halfOpenDatabase.queries.some((query) => query.text.includes("ON CONFLICT"))).toBe(true);
  });
});
