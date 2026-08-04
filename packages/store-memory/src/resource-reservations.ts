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

import { cloneJson, conflict, recordKey, systemNow } from "./internal.js";

function identityWithoutState(value: object): unknown {
  const mutable = new Set([
    "state",
    "status",
    "settlement",
    "settledChargeMs",
    "refundedMs",
    "settledAtServerTime",
  ]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !mutable.has(key)));
}

function admissionReplayKey(request: AdmissionRequest): string | undefined {
  return request.commandId === undefined
    ? undefined
    : recordKey(
        request.tenant.id,
        request.principal.type,
        request.principal.id,
        request.commandId,
        request.category,
        request.resourceKey,
      );
}

export class MemoryQuotaStore implements QuotaStore {
  readonly #limits: readonly QuotaLimit[];
  readonly #now: () => string;
  #reservations = new Map<string, AdmissionReservation>();
  #replays = new Map<string, string>();
  #nextReservation = 1;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    options: { readonly limits?: readonly QuotaLimit[]; readonly now?: () => string } = {},
  ) {
    this.#limits = (options.limits ?? []).map((limit) => QuotaLimitSchema.parse(limit));
    this.#now = options.now ?? systemNow;
  }

  reserve(request: AdmissionRequest): Promise<AdmissionDecision> {
    return this.#exclusive(() => Promise.resolve(this.reserveInTransaction(request)));
  }

  reserveInTransaction(input: AdmissionRequest): AdmissionDecision {
    const request = AdmissionRequestSchema.parse(input);
    const now = this.#now();
    this.reconcileExpiredInTransaction(now);
    const replayKey = admissionReplayKey(request);
    const priorId = replayKey === undefined ? undefined : this.#replays.get(replayKey);
    if (priorId !== undefined) {
      const prior = this.#reservations.get(priorId);
      if (prior === undefined) conflict("admission_replay_missing");
      const expected = {
        tenant: request.tenant,
        principal: request.principal,
        commandId: request.commandId,
        category: request.category,
        resourceKey: request.resourceKey,
        amount: request.amount,
      };
      const actual = {
        tenant: prior.tenant,
        principal: prior.principal,
        commandId: prior.commandId,
        category: prior.category,
        resourceKey: prior.resourceKey,
        amount: prior.amount,
      };
      if (canonicalJsonStringify(expected) !== canonicalJsonStringify(actual)) {
        conflict("admission_replay_changed");
      }
      return { admitted: true, reservation: cloneJson(prior) };
    }
    const limit = this.#limit(request.category, request.resourceKey);
    const used = [...this.#reservations.values()]
      .filter(
        (reservation) =>
          reservation.state === "reserved" &&
          reservation.tenant.id === request.tenant.id &&
          (limit?.scope !== "principal" ||
            (reservation.principal.type === request.principal.type &&
              reservation.principal.id === request.principal.id)) &&
          reservation.category === request.category &&
          reservation.resourceKey === request.resourceKey,
      )
      .reduce((sum, reservation) => sum + reservation.amount, 0);
    if (limit !== undefined && used + request.amount > limit.maximum) {
      return {
        admitted: false,
        code: "KAF_ADMISSION_DENIED",
        retryAfterSeconds: limit.retryAfterSeconds,
      };
    }
    const requestDigest = digestCanonicalJson(request);
    const reservation = AdmissionReservationSchema.parse({
      schemaVersion: "1",
      id: `admission:${requestDigest}:${String(this.#nextReservation)}`,
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
    const sameId = this.#reservations.get(reservation.id);
    if (
      sameId !== undefined &&
      canonicalJsonStringify(sameId) !== canonicalJsonStringify(reservation)
    ) {
      conflict("admission_reservation_id_collision");
    }
    this.#reservations.set(reservation.id, reservation);
    this.#nextReservation += 1;
    if (replayKey !== undefined) this.#replays.set(replayKey, reservation.id);
    return { admitted: true, reservation: cloneJson(reservation) };
  }

  release(
    tenantId: string,
    reservationId: string,
    fencingToken: number,
    releasedAt: string,
  ): Promise<void> {
    return this.#exclusive(() => {
      const prior = this.#reservations.get(reservationId);
      if (prior === undefined || prior.tenant.id !== tenantId) conflict("admission_missing");
      if (prior.fencingToken !== fencingToken) conflict("admission_fence_changed");
      if (prior.state === "released") {
        if (prior.releasedAt !== releasedAt) conflict("admission_release_changed");
        return Promise.resolve();
      }
      if (prior.state !== "reserved") conflict("admission_not_releasable");
      this.#reservations.set(
        reservationId,
        AdmissionReservationSchema.parse({ ...prior, state: "released", releasedAt }),
      );
      return Promise.resolve();
    });
  }

  reconcileExpired(at: string): Promise<number> {
    return this.#exclusive(() => Promise.resolve(this.reconcileExpiredInTransaction(at)));
  }

  reconcileExpiredInTransaction(at: string): number {
    let changed = 0;
    for (const [id, reservation] of this.#reservations) {
      if (
        reservation.state === "reserved" &&
        Date.parse(reservation.leaseExpiresAt) <= Date.parse(at)
      ) {
        this.#reservations.set(id, { ...reservation, state: "expired" });
        changed += 1;
      }
    }
    return changed;
  }

  snapshot(): readonly [
    readonly [string, AdmissionReservation][],
    readonly [string, string][],
    number,
  ] {
    return [
      cloneJson([...this.#reservations]),
      cloneJson([...this.#replays]),
      this.#nextReservation,
    ];
  }

  restore(snapshot: ReturnType<MemoryQuotaStore["snapshot"]>): void {
    this.#reservations = new Map(cloneJson(snapshot[0]));
    this.#replays = new Map(cloneJson(snapshot[1]));
    this.#nextReservation = snapshot[2];
  }

  #limit(metric: QuotaLimit["metric"], resourceKey: string): QuotaLimit | undefined {
    return this.#limits.find(
      (limit) =>
        limit.metric === metric && (limit.resourceKey === resourceKey || limit.resourceKey === "*"),
    );
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class MemoryActiveExecutionReservationStore {
  readonly #now: () => string;
  #reservations = new Map<string, ActiveExecutionReservation>();

  constructor(now: () => string = systemNow) {
    this.#now = now;
  }

  putInTransaction(
    input: ActiveExecutionReservation,
    runMaximumActiveExecutionMs: number,
  ): ActiveExecutionReservation {
    if (!Number.isSafeInteger(runMaximumActiveExecutionMs) || runMaximumActiveExecutionMs <= 0) {
      throw new KafError("KAF_SCHEMA_INVALID", {
        details: {
          path: "runMaximumActiveExecutionMs",
          issue: "positive_safe_integer_required",
        },
      });
    }
    const requested = ActiveExecutionReservationSchema.parse(input);
    const key = recordKey(
      requested.tenant.id,
      requested.runId,
      requested.stepId,
      requested.boundary,
      requested.boundaryKey,
    );
    const prior = this.#reservations.get(key);
    if (prior === undefined) {
      if (requested.state !== "reserved") conflict("active_execution_must_start_reserved");
      const consumed = this.consumedMilliseconds(requested.tenant.id, requested.runId);
      if (consumed + requested.maxChargeMs > runMaximumActiveExecutionMs) {
        throw new KafError("KAF_RUNTIME_CAPABILITY_MISSING", {
          details: {
            reason: "active_execution_budget_exhausted",
            consumedMs: consumed,
            requestedMs: requested.maxChargeMs,
            maximumMs: runMaximumActiveExecutionMs,
          },
        });
      }
      const startedAtServerTime = this.#now();
      const next = ActiveExecutionReservationSchema.parse({
        ...requested,
        startedAtServerTime,
        expiresAt: new Date(Date.parse(startedAtServerTime) + requested.maxChargeMs).toISOString(),
      });
      this.#reservations.set(key, next);
      return cloneJson(next);
    }
    if (canonicalJsonStringify(prior) === canonicalJsonStringify(requested)) {
      return cloneJson(prior);
    }
    if (
      prior.id !== requested.id ||
      prior.leaseId !== requested.leaseId ||
      prior.fencingToken !== requested.fencingToken ||
      canonicalJsonStringify(activeExecutionIdentity(prior)) !==
        canonicalJsonStringify(activeExecutionIdentity(requested))
    ) {
      conflict("active_execution_binding_changed");
    }
    if (prior.state !== "reserved") {
      if (requested.state === prior.state) return cloneJson(prior);
      conflict("active_execution_transition_changed");
    }
    if (requested.state === "reserved") return cloneJson(prior);
    const settledAtServerTime = this.#now();
    const settledChargeMs =
      requested.state === "closed_uncertain"
        ? prior.maxChargeMs
        : Math.min(
            prior.maxChargeMs,
            Math.max(
              0,
              Math.ceil(Date.parse(settledAtServerTime) - Date.parse(prior.startedAtServerTime)),
            ),
          );
    const next = ActiveExecutionReservationSchema.parse({
      ...prior,
      state: requested.state,
      settledChargeMs,
      refundedMs: prior.maxChargeMs - settledChargeMs,
      settledAtServerTime,
    });
    this.#reservations.set(key, next);
    return cloneJson(next);
  }

  get(tenantId: string, runId: string, stepId: string, boundary: string, boundaryKey: string) {
    const value = this.#reservations.get(recordKey(tenantId, runId, stepId, boundary, boundaryKey));
    return value === undefined ? undefined : cloneJson(value);
  }

  reconcileExpired(at?: string): number {
    void at;
    const authoritativeAt = this.#now();
    let changed = 0;
    for (const [key, prior] of this.#reservations) {
      if (
        prior.state === "reserved" &&
        Date.parse(prior.expiresAt) <= Date.parse(authoritativeAt)
      ) {
        this.#reservations.set(
          key,
          ActiveExecutionReservationSchema.parse({
            ...prior,
            state: "closed_uncertain",
            settledChargeMs: prior.maxChargeMs,
            refundedMs: 0,
            settledAtServerTime: authoritativeAt,
          }),
        );
        changed += 1;
      }
    }
    return changed;
  }

  consumedMilliseconds(tenantId: string, runId: string): number {
    return [...this.#reservations.values()]
      .filter((reservation) => reservation.tenant.id === tenantId && reservation.runId === runId)
      .reduce(
        (sum, reservation) =>
          sum +
          (reservation.state === "settled"
            ? (reservation.settledChargeMs ?? reservation.maxChargeMs)
            : reservation.maxChargeMs),
        0,
      );
  }

  snapshot(): readonly (readonly [string, ActiveExecutionReservation])[] {
    return cloneJson([...this.#reservations]);
  }

  restore(snapshot: ReturnType<MemoryActiveExecutionReservationStore["snapshot"]>): void {
    this.#reservations = new Map(cloneJson(snapshot));
  }
}

function activeExecutionIdentity(value: ActiveExecutionReservation): unknown {
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
  return identity;
}

export class MemoryModelCallReservationStore {
  readonly #limits: readonly QuotaLimit[];
  #reservations = new Map<string, ModelCallReservation>();

  constructor(limits: readonly QuotaLimit[] = []) {
    this.#limits = limits.map((limit) => QuotaLimitSchema.parse(limit));
  }

  putInTransaction(input: ModelCallReservation): ModelCallReservation {
    const next = ModelCallReservationSchema.parse(input);
    const key = recordKey(next.tenantId, next.runId, next.stepId, String(next.attempt));
    const prior = this.#reservations.get(key);
    if (prior === undefined) {
      if (next.status !== "accepted") conflict("model_reservation_must_start_accepted");
      if (next.outputBytesMaximum === undefined) conflict("model_reservation_io_maximum_required");
      const maximums = {
        model_tokens: next.inputTokenUpperBound + next.outputTokenMaximum,
        model_io_bytes: next.inputBytes + next.outputBytesMaximum,
        ...(next.maximumCallCostMinor === undefined
          ? {}
          : { model_cost_minor: next.maximumCallCostMinor }),
      } as const;
      for (const [metric, maximum] of Object.entries(maximums)) {
        const limit = this.#limits.find(
          (candidate) =>
            candidate.scope === "tenant" &&
            candidate.metric === metric &&
            (candidate.resourceKey === next.modelSecurityProfileDigest ||
              candidate.resourceKey === "*"),
        );
        if (limit === undefined) continue;
        const used = [...this.#reservations.values()]
          .filter(
            (reservation) =>
              reservation.tenantId === next.tenantId &&
              reservation.modelSecurityProfileDigest === next.modelSecurityProfileDigest,
          )
          .reduce((sum, reservation) => {
            if (reservation.status === "expired") return sum;
            if (reservation.status === "settled" && reservation.settlement !== undefined) {
              return (
                sum +
                (metric === "model_tokens"
                  ? reservation.settlement.chargedTokens
                  : metric === "model_io_bytes"
                    ? reservation.settlement.chargedIoBytes
                    : (reservation.settlement.chargedCostMinor ?? 0))
              );
            }
            return (
              sum +
              (metric === "model_tokens"
                ? reservation.inputTokenUpperBound + reservation.outputTokenMaximum
                : metric === "model_io_bytes"
                  ? reservation.inputBytes + (reservation.outputBytesMaximum ?? 0)
                  : (reservation.maximumCallCostMinor ?? 0))
            );
          }, 0);
        if (used + maximum > limit.maximum) {
          throw new KafError("KAF_ADMISSION_DENIED", {
            details: { retryAfterSeconds: limit.retryAfterSeconds, metric },
          });
        }
      }
      this.#reservations.set(key, next);
      return cloneJson(next);
    }
    if (canonicalJsonStringify(prior) === canonicalJsonStringify(next)) return cloneJson(prior);
    if (
      canonicalJsonStringify(identityWithoutState(prior)) !==
      canonicalJsonStringify(identityWithoutState(next))
    ) {
      conflict("model_reservation_binding_changed");
    }
    const allowed =
      (prior.status === "accepted" && ["dispatched", "settled", "expired"].includes(next.status)) ||
      (prior.status === "dispatched" && ["settled", "uncertain"].includes(next.status));
    if (!allowed) conflict("model_reservation_transition_changed");
    const settlement = next.settlement;
    if (settlement !== undefined) {
      const maximumTokens = next.inputTokenUpperBound + next.outputTokenMaximum;
      const maximumIo = next.inputBytes + (next.outputBytesMaximum ?? 0);
      if (
        settlement.chargedTokens > maximumTokens ||
        (next.outputBytesMaximum !== undefined && settlement.chargedIoBytes > maximumIo) ||
        (next.maximumCallCostMinor !== undefined &&
          (settlement.chargedCostMinor === undefined ||
            settlement.chargedCostMinor > next.maximumCallCostMinor ||
            settlement.currency !== next.currency))
      ) {
        conflict("model_reservation_settlement_exceeds_maximum");
      }
    }
    this.#reservations.set(key, next);
    return cloneJson(next);
  }

  get(tenantId: string, runId: string, stepId: string, attempt: number) {
    const value = this.#reservations.get(recordKey(tenantId, runId, stepId, String(attempt)));
    return value === undefined ? undefined : cloneJson(value);
  }

  snapshot(): readonly (readonly [string, ModelCallReservation])[] {
    return cloneJson([...this.#reservations]);
  }

  restore(snapshot: ReturnType<MemoryModelCallReservationStore["snapshot"]>): void {
    this.#reservations = new Map(cloneJson(snapshot));
  }
}

export type ModelSettlementInput = Readonly<{
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

export class MemoryModelCallReservationServices {
  readonly transactionDomain = "memory.process-local";
  readonly durable = false;
  constructor(readonly now: () => string = systemNow) {}

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
    usage: ModelSettlementInput,
  ) {
    const trusted = usage.trustedProviderUsage;
    const localTokens = usage.inputTokenLowerBound + usage.outputTokenLowerBound;
    const providerTokens = trusted === undefined ? 0 : trusted.inputTokens + trusted.outputTokens;
    const chargedTokens = Math.max(localTokens, providerTokens);
    const chargedIoBytes = usage.inputBytes + usage.outputBytes;
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
        chargedTokens,
        chargedIoBytes,
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

export class MemoryCircuitBreakerStore implements CircuitBreakerStore {
  #states = new Map<string, CircuitBreakerState>();

  get(tenantId: string, providerKey: string): Promise<CircuitBreakerState | undefined> {
    const value = this.#states.get(recordKey(tenantId, providerKey));
    return Promise.resolve(value === undefined ? undefined : cloneJson(value));
  }

  compareAndSet(
    expectedInput: CircuitBreakerState | undefined,
    nextInput: CircuitBreakerState,
  ): Promise<boolean> {
    const expected =
      expectedInput === undefined ? undefined : CircuitBreakerStateSchema.parse(expectedInput);
    const next = CircuitBreakerStateSchema.parse(nextInput);
    const key = recordKey(next.tenantId, next.providerKey);
    const prior = this.#states.get(key);
    if (canonicalJsonStringify(prior ?? null) !== canonicalJsonStringify(expected ?? null)) {
      return Promise.resolve(false);
    }
    if (
      next.state === "half_open" &&
      (next.probeLeaseId === undefined ||
        next.probeFencingToken === undefined ||
        (prior?.probeFencingToken !== undefined &&
          next.probeFencingToken <= prior.probeFencingToken))
    ) {
      throw new KafError("KAF_STORAGE_CONCURRENCY_CONFLICT", {
        details: { reason: "circuit_probe_fence_not_advanced" },
      });
    }
    this.#states.set(key, next);
    return Promise.resolve(true);
  }
}
