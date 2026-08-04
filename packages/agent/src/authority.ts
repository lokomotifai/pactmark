import {
  createAuthorityIssuer,
  type AuthenticationStrength,
  type AuthorityContext,
  type AuthorityIssuer,
  type DecisionRole,
  type Principal,
  type Tenant,
} from "@pactmark/core";

export interface LocalAuthorityIssueInput {
  readonly principal: Principal;
  readonly tenant: Tenant;
  readonly authenticationStrength?: AuthenticationStrength;
  readonly decisionRoles?: readonly DecisionRole[];
  readonly requestCorrelationId?: string;
}

export interface LocalAuthorityIssuer {
  readonly issuer: AuthorityIssuer;
  issue(input: LocalAuthorityIssueInput): AuthorityContext;
}

export interface LocalAuthorityIssuerOptions {
  readonly issuerId?: string;
  readonly validityMs?: number;
  readonly now?: () => Date;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Development-only authority. Production hosts issue authority after authentication. */
export function createLocalAuthorityIssuer(
  options: LocalAuthorityIssuerOptions = {},
): LocalAuthorityIssuer {
  const validityMs = options.validityMs ?? 60 * 60 * 1000;
  if (!Number.isSafeInteger(validityMs) || validityMs <= 0) {
    throw new RangeError("Local authority validity must be a positive integer");
  }
  const now = options.now ?? (() => new Date());
  const issuer = createAuthorityIssuer(options.issuerId ?? "pactmark.local-preview");
  return Object.freeze({
    issuer,
    issue(input: LocalAuthorityIssueInput): AuthorityContext {
      const issued = now();
      const issuedAt = issued.toISOString();
      return issuer.issue({
        actor: input.principal,
        tenant: input.tenant,
        authenticatedAt: issuedAt,
        authenticationStrength: input.authenticationStrength ?? "single_factor",
        decisionRoles: [...(input.decisionRoles ?? [])],
        requestCorrelationId: input.requestCorrelationId ?? `local-request-${randomHex(12)}`,
        issuedAt,
        expiresAt: new Date(issued.getTime() + validityMs).toISOString(),
      });
    },
  });
}

export function randomBytes(byteLength: number): Uint8Array {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new RangeError("Random byte length must be a positive integer");
  }
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
