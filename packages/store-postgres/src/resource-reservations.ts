import {
  ActiveExecutionReservationSchema,
  AdmissionRequestSchema,
  AdmissionReservationSchema,
  CircuitBreakerStateSchema,
  KafError,
  ModelCallReservationSchema,
  QuotaLimitSchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  type ActiveExecutionReservation,
  type AdmissionDecision,
  type AdmissionRequest,
  type AdmissionReservation,
  type CircuitBreakerState,
  type CircuitBreakerStore,
  type ModelCallReservation,
  type QuotaLimit,
  type QuotaStore,
  type RunCommandTransaction,
} from "@pactmark/core";

import type { PostgresClient, PostgresDatabase } from "./database.js";
import { withTransaction } from "./database.js";
import { conflict, parseJsonColumn } from "./internal.js";

type JsonRow = { reservation_json: unknown; request_digest?: string };

function instant(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mutableFree(value: object): string {
  const mutable = new Set([
    "state",
    "status",
    "settlement",
    "settledChargeMs",
    "refundedMs",
    "settledAtServerTime",
  ]);
  return canonicalJsonStringify(
    Object.fromEntries(Object.entries(value).filter(([key]) => !mutable.has(key))),
  );
}

function selectLimit(
  limits: readonly QuotaLimit[],
  metric: QuotaLimit["metric"],
  resourceKey: string,
): QuotaLimit | undefined {
  return limits.find(
    (limit) =>
      limit.metric === metric && (limit.resourceKey === resourceKey || limit.resourceKey === "*"),
  );
}

export async function reserveAdmission(
  client: PostgresClient,
  boundTenantId: string,
  input: AdmissionRequest,
  limitsInput: readonly QuotaLimit[],
): Promise<AdmissionReservation> {
  const request = AdmissionRequestSchema.parse(input);
  if (request.tenant.id !== boundTenantId) conflict("cross_tenant_admission");
  const limits = limitsInput.map((limit) => QuotaLimitSchema.parse(limit));
  const limit = selectLimit(limits, request.category, request.resourceKey);
  const lockKey = canonicalJsonStringify([
    request.tenant.id,
    limit?.scope ?? "principal",
    ...(limit?.scope === "tenant" ? [] : [request.principal.type, request.principal.id]),
    request.category,
    request.resourceKey,
  ]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
  if (request.commandId !== undefined) {
    const prior = await client.query<JsonRow>(
      `SELECT reservation_json,request_digest FROM pactmark_admission_reservations
       WHERE tenant_id=$1 AND principal_type=$2 AND principal_id=$3 AND command_id=$4
         AND category=$5 AND resource_key=$6 FOR UPDATE`,
      [
        request.tenant.id,
        request.principal.type,
        request.principal.id,
        request.commandId,
        request.category,
        request.resourceKey,
      ],
    );
    if (prior.rows[0] !== undefined) {
      if (prior.rows[0].request_digest !== digestCanonicalJson(request)) {
        conflict("admission_replay_changed");
      }
      return AdmissionReservationSchema.parse(parseJsonColumn(prior.rows[0].reservation_json));
    }
  }
  const nowResult = await client.query<{ now: string | Date }>("SELECT clock_timestamp() AS now");
  const now = instant(nowResult.rows[0]?.now ?? new Date());
  await client.query(
    `UPDATE pactmark_admission_reservations
     SET state='expired',reservation_json=jsonb_set(reservation_json,'{state}','"expired"'::jsonb)
     WHERE tenant_id=$1 AND principal_type=$2 AND principal_id=$3 AND category=$4
       AND resource_key=$5 AND state='reserved' AND lease_expires_at <= clock_timestamp()`,
    [
      request.tenant.id,
      request.principal.type,
      request.principal.id,
      request.category,
      request.resourceKey,
    ],
  );
  const usedResult = await client.query<{ used: string | number }>(
    `SELECT COALESCE(SUM(amount),0) AS used FROM pactmark_admission_reservations
     WHERE tenant_id=$1 AND ($6='tenant' OR (principal_type=$2 AND principal_id=$3)) AND category=$4
       AND resource_key=$5 AND state='reserved'`,
    [
      request.tenant.id,
      request.principal.type,
      request.principal.id,
      request.category,
      request.resourceKey,
      limit?.scope ?? "principal",
    ],
  );
  if (
    limit !== undefined &&
    Number(usedResult.rows[0]?.used ?? 0) + request.amount > limit.maximum
  ) {
    throw new KafError("KAF_ADMISSION_DENIED", {
      details: { retryAfterSeconds: limit.retryAfterSeconds },
    });
  }
  const requestDigest = digestCanonicalJson(request);
  const idResult = await client.query<{ id: string | number }>(
    "SELECT nextval('pactmark_reservation_id_seq') AS id",
  );
  const generatedId = idResult.rows[0]?.id;
  if (generatedId === undefined) conflict("admission_id_generation_failed");
  const reservation = AdmissionReservationSchema.parse({
    schemaVersion: "1",
    id: `admission:${String(generatedId)}`,
    tenant: request.tenant,
    principal: request.principal,
    ...(request.commandId === undefined ? {} : { commandId: request.commandId }),
    category: request.category,
    resourceKey: request.resourceKey,
    amount: request.amount,
    state: "reserved",
    fencingToken: 1,
    reservedAtServerTime: now,
    leaseExpiresAt: new Date(Date.parse(now) + request.leaseDurationMs).toISOString(),
  });
  await client.query(
    `INSERT INTO pactmark_admission_reservations
     (tenant_id,reservation_id,principal_type,principal_id,command_id,category,resource_key,amount,
      state,fencing_token,reserved_at,lease_expires_at,released_at,request_digest,reservation_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9,$10::timestamptz,$11::timestamptz,NULL,$12,$13::jsonb)`,
    [
      reservation.tenant.id,
      reservation.id,
      reservation.principal.type,
      reservation.principal.id,
      reservation.commandId ?? null,
      reservation.category,
      reservation.resourceKey,
      reservation.amount,
      reservation.fencingToken,
      reservation.reservedAtServerTime,
      reservation.leaseExpiresAt,
      requestDigest,
      JSON.stringify(reservation),
    ],
  );
  return reservation;
}

export async function putActiveExecutionReservation(
  client: PostgresClient,
  boundTenantId: string,
  input: ActiveExecutionReservation,
  runMaximumActiveExecutionMs: number,
): Promise<ActiveExecutionReservation> {
  if (!Number.isSafeInteger(runMaximumActiveExecutionMs) || runMaximumActiveExecutionMs <= 0) {
    throw new KafError("KAF_SCHEMA_INVALID", {
      details: {
        path: "runMaximumActiveExecutionMs",
        issue: "positive_safe_integer_required",
      },
    });
  }
  const requested = ActiveExecutionReservationSchema.parse(input);
  if (requested.tenant.id !== boundTenantId) conflict("cross_tenant_active_execution");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    digestCanonicalJson({
      tenantId: requested.tenant.id,
      runId: requested.runId,
      resource: "active_execution_budget",
    }),
  ]);
  const priorResult = await client.query<JsonRow>(
    `SELECT reservation_json FROM pactmark_active_execution_reservations
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND boundary=$4 AND boundary_key=$5 FOR UPDATE`,
    [
      requested.tenant.id,
      requested.runId,
      requested.stepId,
      requested.boundary,
      requested.boundaryKey,
    ],
  );
  const nowResult = await client.query<{ now: string | Date }>("SELECT clock_timestamp() AS now");
  const nowValue = nowResult.rows[0]?.now;
  if (nowValue === undefined) conflict("active_execution_database_time_unavailable");
  const now = instant(nowValue);
  if (priorResult.rows[0] === undefined) {
    if (requested.state !== "reserved") conflict("active_execution_must_start_reserved");
    const usedResult = await client.query<{ used: string | number }>(
      `SELECT COALESCE(SUM(
         CASE WHEN state='settled' THEN settled_charge_ms ELSE max_charge_ms END
       ),0) AS used
       FROM pactmark_active_execution_reservations
       WHERE tenant_id=$1 AND run_id=$2`,
      [requested.tenant.id, requested.runId],
    );
    const consumed = Number(usedResult.rows[0]?.used ?? 0);
    if (
      !Number.isSafeInteger(consumed) ||
      consumed < 0 ||
      consumed + requested.maxChargeMs > runMaximumActiveExecutionMs
    ) {
      throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
        details: {
          reason: "active_execution_budget_exhausted",
          consumedMs: consumed,
          requestedMs: requested.maxChargeMs,
          maximumMs: runMaximumActiveExecutionMs,
        },
      });
    }
    const next = ActiveExecutionReservationSchema.parse({
      ...requested,
      startedAtServerTime: now,
      expiresAt: new Date(Date.parse(now) + requested.maxChargeMs).toISOString(),
    });
    await client.query(
      `INSERT INTO pactmark_active_execution_reservations
       (tenant_id,reservation_id,run_id,step_id,boundary,boundary_key,lease_id,fencing_token,
        max_charge_ms,state,settled_charge_ms,refunded_ms,started_at,settled_at,expires_at,
        canonical_digest,reservation_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11::timestamptz,NULL,$12::timestamptz,$13,$14::jsonb)`,
      [
        next.tenant.id,
        next.id,
        next.runId,
        next.stepId,
        next.boundary,
        next.boundaryKey,
        next.leaseId,
        next.fencingToken,
        next.maxChargeMs,
        next.state,
        next.startedAtServerTime,
        next.expiresAt,
        digestCanonicalJson(next),
        JSON.stringify(next),
      ],
    );
    return next;
  }
  const prior = ActiveExecutionReservationSchema.parse(
    parseJsonColumn(priorResult.rows[0].reservation_json),
  );
  if (canonicalJsonStringify(prior) === canonicalJsonStringify(requested)) return prior;
  if (activeExecutionMutableFree(prior) !== activeExecutionMutableFree(requested)) {
    conflict("active_execution_binding_changed");
  }
  if (prior.state !== "reserved") {
    if (requested.state === prior.state) return prior;
    conflict("active_execution_transition_changed");
  }
  if (requested.state === "reserved") return prior;
  const settledChargeMs =
    requested.state === "closed_uncertain"
      ? prior.maxChargeMs
      : Math.min(
          prior.maxChargeMs,
          Math.max(0, Math.ceil(Date.parse(now) - Date.parse(prior.startedAtServerTime))),
        );
  const next = ActiveExecutionReservationSchema.parse({
    ...prior,
    state: requested.state,
    settledChargeMs,
    refundedMs: prior.maxChargeMs - settledChargeMs,
    settledAtServerTime: now,
  });
  await client.query(
    `UPDATE pactmark_active_execution_reservations SET state=$6,settled_charge_ms=$7,
       refunded_ms=$8,settled_at=$9::timestamptz,canonical_digest=$10,reservation_json=$11::jsonb
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND boundary=$4 AND boundary_key=$5`,
    [
      next.tenant.id,
      next.runId,
      next.stepId,
      next.boundary,
      next.boundaryKey,
      next.state,
      next.settledChargeMs,
      next.refundedMs,
      next.settledAtServerTime,
      digestCanonicalJson(next),
      JSON.stringify(next),
    ],
  );
  return next;
}

function activeExecutionMutableFree(value: ActiveExecutionReservation): string {
  const {
    state: _state,
    settledChargeMs: _settledChargeMs,
    refundedMs: _refundedMs,
    settledAtServerTime: _settledAtServerTime,
    startedAtServerTime: _startedAtServerTime,
    expiresAt: _expiresAt,
    ...identity
  } = value;
  void _state;
  void _settledChargeMs;
  void _refundedMs;
  void _settledAtServerTime;
  void _startedAtServerTime;
  void _expiresAt;
  return canonicalJsonStringify(identity);
}

export async function putModelCallReservation(
  client: PostgresClient,
  boundTenantId: string,
  input: ModelCallReservation,
  limitsInput: readonly QuotaLimit[],
): Promise<void> {
  const next = ModelCallReservationSchema.parse(input);
  if (next.tenantId !== boundTenantId) conflict("cross_tenant_model_call");
  const priorResult = await client.query<JsonRow>(
    `SELECT reservation_json FROM pactmark_model_call_reservations
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND attempt=$4 FOR UPDATE`,
    [next.tenantId, next.runId, next.stepId, next.attempt],
  );
  if (priorResult.rows[0] === undefined) {
    if (next.status !== "accepted") conflict("model_reservation_must_start_accepted");
    if (next.outputBytesMaximum === undefined) conflict("model_reservation_io_maximum_required");
    const limits = limitsInput.map((limit) => QuotaLimitSchema.parse(limit));
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      canonicalJsonStringify([next.tenantId, next.modelSecurityProfileDigest]),
    ]);
    const maximums = [
      ["model_tokens", next.inputTokenUpperBound + next.outputTokenMaximum],
      ["model_io_bytes", next.inputBytes + next.outputBytesMaximum],
      ...(next.maximumCallCostMinor === undefined
        ? []
        : [["model_cost_minor", next.maximumCallCostMinor] as const]),
    ] as const;
    for (const [metric, maximum] of maximums) {
      const limit = limits.find(
        (candidate) =>
          candidate.scope === "tenant" &&
          candidate.metric === metric &&
          (candidate.resourceKey === next.modelSecurityProfileDigest ||
            candidate.resourceKey === "*"),
      );
      if (limit === undefined) continue;
      const jsonField =
        metric === "model_tokens"
          ? "chargedTokens"
          : metric === "model_io_bytes"
            ? "chargedIoBytes"
            : "chargedCostMinor";
      const column =
        metric === "model_tokens"
          ? "maximum_tokens"
          : metric === "model_io_bytes"
            ? "maximum_io_bytes"
            : "maximum_cost_minor";
      const used = await client.query<{ used: string | number }>(
        `SELECT COALESCE(SUM(CASE WHEN state='settled'
           THEN COALESCE((reservation_json->'settlement'->>$3)::bigint,0)
           WHEN state IN ('accepted','dispatched','uncertain') THEN ${column} ELSE 0 END),0) AS used
         FROM pactmark_model_call_reservations WHERE tenant_id=$1 AND provider_key=$2`,
        [next.tenantId, next.modelSecurityProfileDigest, jsonField],
      );
      if (Number(used.rows[0]?.used ?? 0) + maximum > limit.maximum) {
        throw new KafError("KAF_ADMISSION_DENIED", {
          details: { retryAfterSeconds: limit.retryAfterSeconds, metric },
        });
      }
    }
    await client.query(
      `INSERT INTO pactmark_model_call_reservations
       (tenant_id,run_id,step_id,attempt,reservation_id,provider_key,maximum_tokens,maximum_io_bytes,
        maximum_cost_minor,currency,state,expires_at,created_at,canonical_digest,reservation_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz,$14,$15::jsonb)`,
      [
        next.tenantId,
        next.runId,
        next.stepId,
        next.attempt,
        next.reservationId,
        next.modelSecurityProfileDigest,
        next.inputTokenUpperBound + next.outputTokenMaximum,
        next.inputBytes + next.outputBytesMaximum,
        next.maximumCallCostMinor ?? null,
        next.currency ?? null,
        next.status,
        next.expiresAt,
        next.createdAt,
        digestCanonicalJson(next),
        JSON.stringify(next),
      ],
    );
    return;
  }
  const prior = ModelCallReservationSchema.parse(
    parseJsonColumn(priorResult.rows[0].reservation_json),
  );
  if (canonicalJsonStringify(prior) === canonicalJsonStringify(next)) return;
  if (mutableFree(prior) !== mutableFree(next)) conflict("model_reservation_binding_changed");
  const allowed =
    (prior.status === "accepted" && ["dispatched", "settled", "expired"].includes(next.status)) ||
    (prior.status === "dispatched" && ["settled", "uncertain"].includes(next.status));
  if (!allowed) conflict("model_reservation_transition_changed");
  const settlement = next.settlement;
  if (
    settlement !== undefined &&
    (settlement.chargedTokens > next.inputTokenUpperBound + next.outputTokenMaximum ||
      (next.outputBytesMaximum !== undefined &&
        settlement.chargedIoBytes > next.inputBytes + next.outputBytesMaximum) ||
      (next.maximumCallCostMinor !== undefined &&
        (settlement.chargedCostMinor === undefined ||
          settlement.chargedCostMinor > next.maximumCallCostMinor ||
          settlement.currency !== next.currency)))
  ) {
    conflict("model_reservation_settlement_exceeds_maximum");
  }
  await client.query(
    `UPDATE pactmark_model_call_reservations SET state=$5,canonical_digest=$6,reservation_json=$7::jsonb
     WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND attempt=$4`,
    [
      next.tenantId,
      next.runId,
      next.stepId,
      next.attempt,
      next.status,
      digestCanonicalJson(next),
      JSON.stringify(next),
    ],
  );
}

export class PostgresQuotaStore implements QuotaStore {
  readonly #limits: readonly QuotaLimit[];
  constructor(
    readonly database: PostgresDatabase,
    limits: readonly QuotaLimit[] = [],
  ) {
    this.#limits = limits.map((limit) => QuotaLimitSchema.parse(limit));
  }

  reserve(request: AdmissionRequest): Promise<AdmissionDecision> {
    return withTransaction(this.database, async (client) => {
      try {
        return {
          admitted: true,
          reservation: await reserveAdmission(client, request.tenant.id, request, this.#limits),
        };
      } catch (error) {
        if (error instanceof KafError && error.code === "KAF_ADMISSION_DENIED") {
          const limit = selectLimit(this.#limits, request.category, request.resourceKey);
          return {
            admitted: false,
            code: error.code,
            retryAfterSeconds: limit?.retryAfterSeconds ?? 1,
          };
        }
        throw error;
      }
    });
  }

  release(
    tenantId: string,
    reservationId: string,
    fencingToken: number,
    releasedAt: string,
  ): Promise<void> {
    return withTransaction(this.database, async (client) => {
      const found = await client.query<JsonRow>(
        `SELECT reservation_json FROM pactmark_admission_reservations
         WHERE tenant_id=$1 AND reservation_id=$2 FOR UPDATE`,
        [tenantId, reservationId],
      );
      if (found.rows[0] === undefined) conflict("admission_missing");
      const prior = AdmissionReservationSchema.parse(
        parseJsonColumn(found.rows[0].reservation_json),
      );
      if (prior.fencingToken !== fencingToken) conflict("admission_fence_changed");
      if (prior.state === "released") {
        if (prior.releasedAt !== releasedAt) conflict("admission_release_changed");
        return;
      }
      if (prior.state !== "reserved") conflict("admission_not_releasable");
      const next = AdmissionReservationSchema.parse({ ...prior, state: "released", releasedAt });
      await client.query(
        `UPDATE pactmark_admission_reservations SET state='released',released_at=$3::timestamptz,
         reservation_json=$4::jsonb WHERE tenant_id=$1 AND reservation_id=$2`,
        [tenantId, reservationId, releasedAt, JSON.stringify(next)],
      );
    });
  }

  reconcileExpired(at: string): Promise<number> {
    return withTransaction(this.database, async (client) => {
      const result = await client.query(
        `UPDATE pactmark_admission_reservations SET state='expired',
         reservation_json=jsonb_set(reservation_json,'{state}','"expired"'::jsonb)
         WHERE state='reserved' AND lease_expires_at <= $1::timestamptz`,
        [at],
      );
      return result.rowCount;
    });
  }
}

export class PostgresActiveExecutionReservationStore {
  constructor(readonly database: PostgresDatabase) {}

  async get(
    tenantId: string,
    reservationId: string,
  ): Promise<ActiveExecutionReservation | undefined> {
    const result = await this.database.query<JsonRow>(
      `SELECT reservation_json FROM pactmark_active_execution_reservations
       WHERE tenant_id=$1 AND reservation_id=$2`,
      [tenantId, reservationId],
    );
    return result.rows[0] === undefined
      ? undefined
      : ActiveExecutionReservationSchema.parse(parseJsonColumn(result.rows[0].reservation_json));
  }

  async getByBoundary(
    tenantId: string,
    runId: string,
    stepId: string,
    boundary: ActiveExecutionReservation["boundary"],
    boundaryKey: string,
  ): Promise<ActiveExecutionReservation | undefined> {
    const result = await this.database.query<JsonRow>(
      `SELECT reservation_json FROM pactmark_active_execution_reservations
       WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND boundary=$4 AND boundary_key=$5`,
      [tenantId, runId, stepId, boundary, boundaryKey],
    );
    return result.rows[0] === undefined
      ? undefined
      : ActiveExecutionReservationSchema.parse(parseJsonColumn(result.rows[0].reservation_json));
  }

  reconcileExpired(at?: string): Promise<number> {
    void at;
    return withTransaction(this.database, async (client) => {
      const result = await client.query<JsonRow>(
        `SELECT reservation_json FROM pactmark_active_execution_reservations
         WHERE state='reserved' AND expires_at <= clock_timestamp()`,
      );
      for (const row of result.rows) {
        const prior = ActiveExecutionReservationSchema.parse(parseJsonColumn(row.reservation_json));
        await putActiveExecutionReservation(
          client,
          prior.tenant.id,
          {
            ...prior,
            state: "closed_uncertain",
            settledChargeMs: prior.maxChargeMs,
            refundedMs: 0,
            settledAtServerTime: prior.expiresAt,
          },
          Number.MAX_SAFE_INTEGER,
        );
      }
      return result.rowCount;
    });
  }
}

export class PostgresModelCallReservationStore {
  constructor(readonly database: PostgresDatabase) {}

  async get(tenantId: string, runId: string, stepId: string, attempt: number) {
    const result = await this.database.query<JsonRow>(
      `SELECT reservation_json FROM pactmark_model_call_reservations
       WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3 AND attempt=$4`,
      [tenantId, runId, stepId, attempt],
    );
    return result.rows[0] === undefined
      ? undefined
      : ModelCallReservationSchema.parse(parseJsonColumn(result.rows[0].reservation_json));
  }

  reconcileExpired(at: string): Promise<number> {
    return withTransaction(this.database, async (client) => {
      const result = await client.query<JsonRow>(
        `SELECT reservation_json FROM pactmark_model_call_reservations
         WHERE state IN ('accepted','dispatched') AND expires_at <= $1::timestamptz FOR UPDATE`,
        [at],
      );
      for (const row of result.rows) {
        const prior = ModelCallReservationSchema.parse(parseJsonColumn(row.reservation_json));
        await putModelCallReservation(
          client,
          prior.tenantId,
          { ...prior, status: prior.status === "dispatched" ? "uncertain" : "expired" },
          [],
        );
      }
      return result.rowCount;
    });
  }
}

export class PostgresCircuitBreakerStore implements CircuitBreakerStore {
  constructor(readonly database: PostgresDatabase) {}

  async get(tenantId: string, providerKey: string): Promise<CircuitBreakerState | undefined> {
    const result = await this.database.query<{ state_json: unknown }>(
      "SELECT state_json FROM pactmark_circuit_breakers WHERE tenant_id=$1 AND provider_key=$2",
      [tenantId, providerKey],
    );
    return result.rows[0] === undefined
      ? undefined
      : CircuitBreakerStateSchema.parse(parseJsonColumn(result.rows[0].state_json));
  }

  compareAndSet(
    expectedInput: CircuitBreakerState | undefined,
    nextInput: CircuitBreakerState,
  ): Promise<boolean> {
    return withTransaction(this.database, async (client) => {
      const expected =
        expectedInput === undefined ? undefined : CircuitBreakerStateSchema.parse(expectedInput);
      const next = CircuitBreakerStateSchema.parse(nextInput);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        canonicalJsonStringify([next.tenantId, next.providerKey]),
      ]);
      const found = await client.query<{ state_json: unknown }>(
        "SELECT state_json FROM pactmark_circuit_breakers WHERE tenant_id=$1 AND provider_key=$2 FOR UPDATE",
        [next.tenantId, next.providerKey],
      );
      const prior =
        found.rows[0] === undefined
          ? undefined
          : CircuitBreakerStateSchema.parse(parseJsonColumn(found.rows[0].state_json));
      if (canonicalJsonStringify(prior ?? null) !== canonicalJsonStringify(expected ?? null))
        return false;
      if (
        next.state === "half_open" &&
        (next.probeLeaseId === undefined ||
          next.probeFencingToken === undefined ||
          (prior?.probeFencingToken !== undefined &&
            next.probeFencingToken <= prior.probeFencingToken))
      )
        conflict("circuit_probe_fence_not_advanced");
      await client.query(
        `INSERT INTO pactmark_circuit_breakers
         (tenant_id,provider_key,state,failure_count,opened_at,probe_lease_id,probe_fencing_token,
          updated_at,canonical_digest,state_json)
         VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8::timestamptz,$9,$10::jsonb)
         ON CONFLICT (tenant_id,provider_key) DO UPDATE SET state=EXCLUDED.state,
          failure_count=EXCLUDED.failure_count,opened_at=EXCLUDED.opened_at,
          probe_lease_id=EXCLUDED.probe_lease_id,probe_fencing_token=EXCLUDED.probe_fencing_token,
          updated_at=EXCLUDED.updated_at,canonical_digest=EXCLUDED.canonical_digest,
          state_json=EXCLUDED.state_json`,
        [
          next.tenantId,
          next.providerKey,
          next.state,
          next.failureCount,
          next.openedAt ?? null,
          next.probeLeaseId ?? null,
          next.probeFencingToken ?? null,
          next.updatedAt,
          digestCanonicalJson(next),
          JSON.stringify(next),
        ],
      );
      return true;
    });
  }
}

export type PostgresModelSettlementInput = Readonly<{
  inputBytes: number;
  inputTokenLowerBound: number;
  outputBytes: number;
  outputTokenLowerBound: number;
  trustedProviderUsage?: Readonly<{
    inputTokens: number;
    outputTokens: number;
    callCostMinor?: number;
    currency?: string;
  }>;
}>;

export class PostgresModelCallReservationServices {
  readonly transactionDomain = "postgres.main";
  readonly durable = true;
  constructor(readonly now: () => string = () => new Date().toISOString()) {}

  async reserve(transaction: RunCommandTransaction, reservation: ModelCallReservation) {
    const { settlement: _settlement, ...identity } = reservation;
    void _settlement;
    const accepted = ModelCallReservationSchema.parse({
      ...identity,
      status: "accepted",
    });
    await transaction.putModelCallReservation(accepted);
    return accepted;
  }

  async markDispatched(transaction: RunCommandTransaction, reservation: ModelCallReservation) {
    const { settlement: _settlement, ...identity } = reservation;
    void _settlement;
    const dispatched = ModelCallReservationSchema.parse({
      ...identity,
      status: "dispatched",
    });
    await transaction.putModelCallReservation(dispatched);
    return dispatched;
  }

  async settle(
    transaction: RunCommandTransaction,
    reservation: ModelCallReservation,
    usage: PostgresModelSettlementInput,
  ) {
    const trusted = usage.trustedProviderUsage;
    const chargedCostMinor =
      reservation.maximumCallCostMinor === undefined
        ? undefined
        : Math.max(trusted?.callCostMinor ?? reservation.maximumCallCostMinor, 0);
    const settled = ModelCallReservationSchema.parse({
      ...reservation,
      status: "settled",
      settlement: {
        schemaVersion: "1",
        inputBytes: usage.inputBytes,
        inputTokenLowerBound: usage.inputTokenLowerBound,
        outputBytes: usage.outputBytes,
        outputTokenLowerBound: usage.outputTokenLowerBound,
        chargedTokens: Math.max(
          usage.inputTokenLowerBound + usage.outputTokenLowerBound,
          trusted === undefined ? 0 : trusted.inputTokens + trusted.outputTokens,
        ),
        chargedIoBytes: usage.inputBytes + usage.outputBytes,
        ...(chargedCostMinor === undefined
          ? {}
          : { chargedCostMinor, currency: trusted?.currency ?? reservation.currency }),
        settledAt: this.now(),
      },
    });
    await transaction.putModelCallReservation(settled);
    return settled;
  }

  async markUncertain(transaction: RunCommandTransaction, reservation: ModelCallReservation) {
    const { settlement: _settlement, ...identity } = reservation;
    void _settlement;
    const uncertain = ModelCallReservationSchema.parse({
      ...identity,
      status: "uncertain",
    });
    await transaction.putModelCallReservation(uncertain);
    return uncertain;
  }
}
