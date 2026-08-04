import {
  AdmissionRequestSchema,
  AdmissionReservationSchema,
  canonicalJsonStringify,
  type AdmissionCategory,
  type AdmissionController,
  type AdmissionDecision,
  type AdmissionRequest,
  type AdmissionReservation,
  type Clock,
  type IdGenerator,
  type QuotaStore,
} from "@pactmark/core";

export class AdmissionError extends Error {
  readonly code = "KAF_POLICY_ADMISSION_CONFLICT" as const;

  constructor(readonly reason: string) {
    super(reason);
    this.name = "AdmissionError";
  }
}

export type MemoryAdmissionLimit = Readonly<{
  category: AdmissionCategory;
  maximum: number;
  retryAfterSeconds: number;
}>;

function scopeKey(request: AdmissionRequest): string {
  return [
    request.tenant.id,
    request.principal.type,
    request.principal.id,
    request.category,
    request.resourceKey,
  ].join(":");
}

/** Development-only admission reference; production readiness requires a durable QuotaStore. */
export function createMemoryAdmissionController(input: {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly limits: readonly MemoryAdmissionLimit[];
}): Readonly<{ controller: AdmissionController; quotaStore: QuotaStore }> {
  const limits = new Map(
    input.limits.map((limit) => {
      if (!Number.isFinite(limit.maximum) || limit.maximum <= 0) {
        throw new AdmissionError("Admission maximum must be finite and positive");
      }
      if (!Number.isInteger(limit.retryAfterSeconds) || limit.retryAfterSeconds < 1) {
        throw new AdmissionError("Retry-After must be a positive integer");
      }
      return [limit.category, Object.freeze(limit)] as const;
    }),
  );
  const reservations = new Map<string, AdmissionReservation>();
  const replayRequests = new Map<string, string>();

  const quotaStore: QuotaStore = Object.freeze({
    reserve(rawRequest: AdmissionRequest): Promise<AdmissionDecision> {
      return Promise.resolve().then(() => {
        const request = AdmissionRequestSchema.parse(rawRequest);
        const limit = limits.get(request.category);
        if (limit === undefined) {
          return { admitted: false, code: "KAF_POLICY_ADMISSION_DENIED", retryAfterSeconds: 60 };
        }
        const scope = scopeKey(request);
        const replayKey =
          request.commandId === undefined ? undefined : `${scope}:command:${request.commandId}`;
        if (replayKey !== undefined) {
          const reservationId = replayRequests.get(replayKey);
          if (reservationId !== undefined) {
            const replay = reservations.get(reservationId);
            if (replay === undefined)
              throw new AdmissionError("Admission replay record is corrupt");
            const originalRequest = {
              schemaVersion: "1",
              tenant: replay.tenant,
              principal: replay.principal,
              commandId: replay.commandId,
              category: replay.category,
              resourceKey: replay.resourceKey,
              amount: replay.amount,
              leaseDurationMs:
                Date.parse(replay.leaseExpiresAt) - Date.parse(replay.reservedAtServerTime),
            };
            if (canonicalJsonStringify(originalRequest) !== canonicalJsonStringify(request)) {
              throw new AdmissionError(
                "Same command was reused with a different admission request",
              );
            }
            return { admitted: true, reservation: replay };
          }
        }
        const now = input.clock.now();
        const activeAmount = [...reservations.values()]
          .filter(
            (reservation) =>
              reservation.state === "reserved" &&
              Date.parse(reservation.leaseExpiresAt) > Date.parse(now) &&
              [
                reservation.tenant.id,
                reservation.principal.type,
                reservation.principal.id,
                reservation.category,
                reservation.resourceKey,
              ].join(":") === scope,
          )
          .reduce((total, reservation) => total + reservation.amount, 0);
        if (activeAmount + request.amount > limit.maximum) {
          return {
            admitted: false,
            code: "KAF_POLICY_ADMISSION_LIMIT",
            retryAfterSeconds: Math.min(limit.retryAfterSeconds, 3600),
          };
        }
        const reservation = Object.freeze(
          AdmissionReservationSchema.parse({
            schemaVersion: "1",
            id: input.idGenerator.generate("admission"),
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
          }),
        );
        reservations.set(reservation.id, reservation);
        if (replayKey !== undefined) replayRequests.set(replayKey, reservation.id);
        return { admitted: true, reservation };
      });
    },
    release(tenantId: string, reservationId: string, fencingToken: number, releasedAt: string) {
      return Promise.resolve().then(() => {
        const reservation = reservations.get(reservationId);
        if (
          reservation === undefined ||
          reservation.tenant.id !== tenantId ||
          reservation.fencingToken !== fencingToken
        ) {
          throw new AdmissionError("Admission release binding is invalid");
        }
        if (reservation.state !== "reserved") return;
        reservations.set(
          reservationId,
          Object.freeze(
            AdmissionReservationSchema.parse({
              ...reservation,
              state: "released",
              releasedAt,
            }),
          ),
        );
      });
    },
    reconcileExpired(at: string) {
      return Promise.resolve().then(() => {
        let count = 0;
        for (const [id, reservation] of reservations) {
          if (
            reservation.state === "reserved" &&
            Date.parse(reservation.leaseExpiresAt) <= Date.parse(at)
          ) {
            reservations.set(
              id,
              Object.freeze(AdmissionReservationSchema.parse({ ...reservation, state: "expired" })),
            );
            count += 1;
          }
        }
        return count;
      });
    },
  });
  const controller: AdmissionController = Object.freeze({
    evaluate: (request: AdmissionRequest) => quotaStore.reserve(request),
  });
  return Object.freeze({ controller, quotaStore });
}
