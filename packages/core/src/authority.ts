import { z } from "zod";

export const PrincipalSchema = z
  .object({
    type: z.enum(["user", "service", "system_worker"]),
    id: z.string().trim().min(1).max(256),
  })
  .strict();
export type Principal = z.infer<typeof PrincipalSchema>;

export const TenantSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
  })
  .strict();
export type Tenant = z.infer<typeof TenantSchema>;

export const AuthenticationStrengthSchema = z.enum([
  "single_factor",
  "multi_factor",
  "phishing_resistant",
  "user_presence",
]);
export type AuthenticationStrength = z.infer<typeof AuthenticationStrengthSchema>;

export const DecisionRoleSchema = z.string().trim().min(1).max(128);
export type DecisionRole = z.infer<typeof DecisionRoleSchema>;

export const AuthorityClaimsSchema = z
  .object({
    schemaVersion: z.literal("1"),
    issuerId: z.string().trim().min(1).max(256),
    actor: PrincipalSchema,
    subject: PrincipalSchema.optional(),
    tenant: TenantSchema,
    authenticatedAt: z.iso.datetime({ offset: true }),
    authenticationStrength: AuthenticationStrengthSchema,
    decisionRoles: z.array(DecisionRoleSchema).max(64),
    requestCorrelationId: z.string().trim().min(1).max(256),
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    runScope: z
      .object({
        runId: z.string().trim().min(1).max(256),
        workOrderId: z.string().trim().min(1).max(256),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AuthorityClaims = z.infer<typeof AuthorityClaimsSchema>;

declare const AUTHORITY_CONTEXT_BRAND: unique symbol;

/**
 * A process-local capability object. It deliberately has no public fields and
 * cannot be reconstructed from its claims or from JSON.
 */
export type AuthorityContext = Readonly<{
  [AUTHORITY_CONTEXT_BRAND]: "AuthorityContext";
}>;

export type AuthorityVerification =
  | { readonly valid: true; readonly claims: AuthorityClaims }
  | {
      readonly valid: false;
      readonly reason: "not_issued" | "other_issuer" | "expired" | "not_yet_valid";
    };

export interface AuthorityIssuer {
  readonly issuerId: string;
  issue(claims: Omit<AuthorityClaims, "schemaVersion" | "issuerId">): AuthorityContext;
  verify(authority: unknown, at: Date): AuthorityVerification;
}

type AuthorityState = {
  readonly issuerProof: object;
  readonly claims: AuthorityClaims;
};

const authorityStates = new WeakMap<object, AuthorityState>();

/**
 * Builds an issuer boundary for a trusted host adapter. Calling `issue` is a
 * privileged host action; request/model JSON must never be routed to it.
 */
export function createAuthorityIssuer(issuerId: string): AuthorityIssuer {
  const validatedIssuerId = z.string().trim().min(1).max(256).parse(issuerId);
  const issuerProof = Object.freeze({});

  return Object.freeze({
    issuerId: validatedIssuerId,
    issue(claimsInput: Omit<AuthorityClaims, "schemaVersion" | "issuerId">): AuthorityContext {
      const claims = AuthorityClaimsSchema.parse({
        ...claimsInput,
        schemaVersion: "1",
        issuerId: validatedIssuerId,
      });
      const context = Object.create(null) as object;
      Object.defineProperty(context, "toJSON", {
        enumerable: false,
        value(): never {
          throw new TypeError("AuthorityContext is not serializable");
        },
      });
      Object.freeze(context);
      authorityStates.set(context, { issuerProof, claims });
      return context as AuthorityContext;
    },
    verify(authority: unknown, at: Date): AuthorityVerification {
      if (
        (typeof authority !== "object" && typeof authority !== "function") ||
        authority === null
      ) {
        return { valid: false, reason: "not_issued" };
      }
      const state = authorityStates.get(authority);
      if (state === undefined) {
        return { valid: false, reason: "not_issued" };
      }
      if (state.issuerProof !== issuerProof) {
        return { valid: false, reason: "other_issuer" };
      }
      const instant = at.getTime();
      if (instant < Date.parse(state.claims.issuedAt)) {
        return { valid: false, reason: "not_yet_valid" };
      }
      if (instant >= Date.parse(state.claims.expiresAt)) {
        return { valid: false, reason: "expired" };
      }
      return { valid: true, claims: state.claims };
    },
  });
}
