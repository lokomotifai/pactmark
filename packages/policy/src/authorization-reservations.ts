import {
  AuthorizationReservationSchema,
  canonicalJsonStringify,
  type AuthorizationReservation,
} from "@pactmark/core";

export class AuthorizationReservationError extends Error {
  constructor(
    readonly code:
      | "KAF_POLICY_AUTHORIZATION_BINDING_MISMATCH"
      | "KAF_POLICY_AUTHORIZATION_EXPIRED"
      | "KAF_POLICY_AUTHORIZATION_CLAIM_EXHAUSTED"
      | "KAF_POLICY_AUTHORIZATION_DUPLICATE",
  ) {
    super(code);
    this.name = "AuthorizationReservationError";
  }
}

export interface AuthorizationReservationStore {
  reserve(reservation: AuthorizationReservation, at: string): Promise<AuthorizationReservation>;
  get(tenantId: string, authorizationKey: string): Promise<AuthorizationReservation | undefined>;
  consume(
    tenantId: string,
    authorizationKey: string,
    consumedAt: string,
  ): Promise<AuthorizationReservation>;
}

type ClaimIndex = Map<string, Map<string, string>>;

function sameReservation(left: AuthorizationReservation, right: AuthorizationReservation): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function reserveClaim(
  index: ClaimIndex,
  subjectId: string,
  authorizationKey: string,
  reservationId: string,
  maximumUses: number,
): void {
  const claims = index.get(subjectId) ?? new Map<string, string>();
  const replay = claims.get(authorizationKey);
  if (replay !== undefined) {
    if (replay !== reservationId) {
      throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_BINDING_MISMATCH");
    }
    return;
  }
  if (claims.size >= maximumUses) {
    throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_CLAIM_EXHAUSTED");
  }
  claims.set(authorizationKey, reservationId);
  index.set(subjectId, claims);
}

function assertClaimAvailable(
  index: ClaimIndex,
  subjectId: string,
  authorizationKey: string,
  reservationId: string,
  maximumUses: number,
): void {
  const claims = index.get(subjectId);
  const replay = claims?.get(authorizationKey);
  if (replay !== undefined && replay !== reservationId) {
    throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_BINDING_MISMATCH");
  }
  if (replay === undefined && (claims?.size ?? 0) >= maximumUses) {
    throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_CLAIM_EXHAUSTED");
  }
}

/**
 * Process-local reference implementation. Durable adapters must make these
 * claims and their effect/command writes in one database transaction.
 */
export function createMemoryAuthorizationReservationStore(input: {
  readonly grantMaximumUses: (grantId: string) => number | undefined;
  readonly secretRefMaximumUses: (secretRefId: string) => number | undefined;
  readonly approvalMaximumUses?: (approvalId: string) => number | undefined;
}): AuthorizationReservationStore {
  const reservations = new Map<string, AuthorizationReservation>();
  const grantClaims: ClaimIndex = new Map();
  const approvalClaims: ClaimIndex = new Map();
  const secretClaims: ClaimIndex = new Map();

  const store: AuthorizationReservationStore = {
    reserve(rawReservation, at) {
      return Promise.resolve().then(() => {
        const reservation = AuthorizationReservationSchema.parse(rawReservation);
        if (reservation.state !== "reserved") {
          throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_BINDING_MISMATCH");
        }
        if (Date.parse(at) >= Date.parse(reservation.expiresAt)) {
          throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_EXPIRED");
        }
        const scopedKey = `${reservation.tenantId}:${reservation.authorizationKey}`;
        const replay = reservations.get(scopedKey);
        if (replay !== undefined) {
          if (!sameReservation(replay, reservation)) {
            throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_BINDING_MISMATCH");
          }
          return replay;
        }
        if (
          [...reservations.values()].some(
            (candidate) =>
              candidate.authorizationReservationId === reservation.authorizationReservationId,
          )
        ) {
          throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_DUPLICATE");
        }

        const grantLimit = input.grantMaximumUses(reservation.grantId);
        if (grantLimit === undefined || grantLimit < 1) {
          throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_CLAIM_EXHAUSTED");
        }
        const approvalLimit =
          reservation.approvalId === undefined
            ? undefined
            : input.approvalMaximumUses?.(reservation.approvalId);
        if (
          reservation.approvalId !== undefined &&
          (approvalLimit === undefined || approvalLimit < 1)
        ) {
          throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_CLAIM_EXHAUSTED");
        }
        const secretLimits = reservation.secretRefIds.map(
          (refId) => [refId, input.secretRefMaximumUses(refId)] as const,
        );
        if (secretLimits.some(([, limit]) => limit === undefined || limit < 1)) {
          throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_CLAIM_EXHAUSTED");
        }

        assertClaimAvailable(
          grantClaims,
          reservation.grantId,
          reservation.authorizationKey,
          reservation.authorizationReservationId,
          grantLimit,
        );
        if (reservation.approvalId !== undefined && approvalLimit !== undefined) {
          assertClaimAvailable(
            approvalClaims,
            reservation.approvalId,
            reservation.authorizationKey,
            reservation.authorizationReservationId,
            approvalLimit,
          );
        }
        for (const [refId, limit] of secretLimits) {
          if (limit !== undefined) {
            assertClaimAvailable(
              secretClaims,
              refId,
              reservation.authorizationKey,
              reservation.authorizationReservationId,
              limit,
            );
          }
        }

        reserveClaim(
          grantClaims,
          reservation.grantId,
          reservation.authorizationKey,
          reservation.authorizationReservationId,
          grantLimit,
        );
        if (reservation.approvalId !== undefined && approvalLimit !== undefined) {
          reserveClaim(
            approvalClaims,
            reservation.approvalId,
            reservation.authorizationKey,
            reservation.authorizationReservationId,
            approvalLimit,
          );
        }
        for (const [refId, limit] of secretLimits) {
          if (limit === undefined) {
            throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_CLAIM_EXHAUSTED");
          }
          reserveClaim(
            secretClaims,
            refId,
            reservation.authorizationKey,
            reservation.authorizationReservationId,
            limit,
          );
        }
        const stored = Object.freeze(reservation);
        reservations.set(scopedKey, stored);
        return stored;
      });
    },
    get(tenantId, authorizationKey) {
      return Promise.resolve(reservations.get(`${tenantId}:${authorizationKey}`));
    },
    consume(tenantId, authorizationKey, consumedAt) {
      return Promise.resolve().then(() => {
        const scopedKey = `${tenantId}:${authorizationKey}`;
        const existing = reservations.get(scopedKey);
        if (existing === undefined) {
          throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_BINDING_MISMATCH");
        }
        if (existing.state === "consumed") return existing;
        if (Date.parse(consumedAt) >= Date.parse(existing.expiresAt)) {
          throw new AuthorizationReservationError("KAF_POLICY_AUTHORIZATION_EXPIRED");
        }
        const consumed = Object.freeze(
          AuthorizationReservationSchema.parse({
            ...existing,
            state: "consumed",
            consumedAt,
          }),
        );
        reservations.set(scopedKey, consumed);
        return consumed;
      });
    },
  };
  return Object.freeze(store);
}
