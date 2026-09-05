import {
  CapabilityGrantBindingSchema,
  CapabilityGrantIssueRequestSchema,
  CapabilityGrantSchema,
  canonicalJsonStringify,
  type AuthorityContext,
  type AuthorityIssuer,
  type CapabilityGrant,
  type CapabilityGrantBinding,
  type CapabilityGrantIssueRequest,
  type CapabilityGrantResolution,
  type CapabilityGrantStore,
  type CapabilityGrantUseClaim,
  type Clock,
  type GrantIssuer,
  type IdGenerator,
} from "@pactmark/core";

export class GrantError extends Error {
  constructor(
    readonly code:
      | "KAF_AUTHORITY_INVALID"
      | "KAF_POLICY_GRANT_BINDING_MISMATCH"
      | "KAF_POLICY_GRANT_DUPLICATE"
      | "KAF_POLICY_GRANT_MISSING"
      | "KAF_POLICY_GRANT_EXPIRED"
      | "KAF_POLICY_GRANT_REVOKED"
      | "KAF_POLICY_GRANT_EXHAUSTED",
  ) {
    super(code);
    this.name = "GrantError";
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

export function createGrantIssuer(input: {
  readonly authorityIssuer: AuthorityIssuer;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}): GrantIssuer {
  const issuer: GrantIssuer = {
    issue(authority: AuthorityContext, requests: readonly CapabilityGrantIssueRequest[]) {
      return Promise.resolve().then(() => {
        const at = input.clock.now();
        const verified = input.authorityIssuer.verify(authority, new Date(at));
        if (!verified.valid) throw new GrantError("KAF_AUTHORITY_INVALID");
        return requests.map((rawRequest) => {
          const request = CapabilityGrantIssueRequestSchema.parse(rawRequest);
          if (
            request.tenant.id !== verified.claims.tenant.id ||
            !sameJson(request.principal, verified.claims.subject ?? verified.claims.actor) ||
            Date.parse(request.expiresAt) <= Date.parse(at)
          ) {
            throw new GrantError("KAF_POLICY_GRANT_BINDING_MISMATCH");
          }
          return Object.freeze(
            CapabilityGrantSchema.parse({
              ...request,
              schemaVersion: "1",
              id: input.idGenerator.generate("grant"),
              issuerId: input.authorityIssuer.issuerId,
              issuedAt: at,
            }),
          );
        });
      });
    },
  };
  return Object.freeze(issuer);
}

type StoredGrant = {
  grant: CapabilityGrant;
  claims: Map<string, CapabilityGrantUseClaim>;
  revokedAt?: string;
};

function matchesBinding(grant: CapabilityGrant, rawBinding: CapabilityGrantBinding): boolean {
  const binding = CapabilityGrantBindingSchema.parse(rawBinding);
  const material: CapabilityGrantBinding = {
    issuerId: grant.issuerId,
    principal: grant.principal,
    tenant: grant.tenant,
    workOrderId: grant.workOrderId,
    workOrderBindingDigest: grant.workOrderBindingDigest,
    executionDefinition: grant.executionDefinition,
    executionDefinitionDigest: grant.executionDefinitionDigest,
    capability: grant.capability,
    action: grant.action,
    toolId: grant.toolId,
    toolVersion: grant.toolVersion,
    toolRegistrationDigest: grant.toolRegistrationDigest,
    normalizedResources: grant.normalizedResources,
    purpose: grant.purpose,
    policyRegistrationDigest: grant.policyRegistrationDigest,
  };
  return sameJson(binding, material);
}

export function createMemoryCapabilityGrantStore(): CapabilityGrantStore {
  const grants = new Map<string, Map<string, StoredGrant>>();

  const grantsForTenant = (tenantId: string): Map<string, StoredGrant> => {
    const existing = grants.get(tenantId);
    if (existing !== undefined) return existing;
    const created = new Map<string, StoredGrant>();
    grants.set(tenantId, created);
    return created;
  };

  const getGrant = (tenantId: string, grantId: string): StoredGrant | undefined =>
    grants.get(tenantId)?.get(grantId);

  const store: CapabilityGrantStore = {
    issue(rawGrant: CapabilityGrant) {
      return Promise.resolve().then(() => {
        const grant = Object.freeze(CapabilityGrantSchema.parse(rawGrant));
        const tenantGrants = grantsForTenant(grant.tenant.id);
        if (tenantGrants.has(grant.id)) throw new GrantError("KAF_POLICY_GRANT_DUPLICATE");
        tenantGrants.set(grant.id, { grant, claims: new Map() });
      });
    },
    revoke(tenantId: string, grantId: string, revokedAt: string) {
      return Promise.resolve().then(() => {
        const stored = getGrant(tenantId, grantId);
        if (stored === undefined) throw new GrantError("KAF_POLICY_GRANT_MISSING");
        stored.revokedAt = revokedAt;
      });
    },
    resolve(
      grantId: string,
      binding: CapabilityGrantBinding,
      at: string,
    ): Promise<CapabilityGrantResolution> {
      return Promise.resolve().then(() => {
        const parsedBinding = CapabilityGrantBindingSchema.parse(binding);
        const stored = getGrant(parsedBinding.tenant.id, grantId);
        if (stored === undefined) return { status: "missing" } as const;
        if (!matchesBinding(stored.grant, parsedBinding)) {
          return { status: "binding_mismatch" } as const;
        }
        if (stored.revokedAt !== undefined || stored.grant.revokedAt !== undefined) {
          return { status: "revoked" } as const;
        }
        if (Date.parse(at) >= Date.parse(stored.grant.expiresAt)) {
          return { status: "expired" } as const;
        }
        const remaining = stored.grant.maximumUses - stored.claims.size;
        return remaining <= 0
          ? ({ status: "exhausted" } as const)
          : ({ status: "active", grant: stored.grant, usesRemaining: remaining } as const);
      });
    },
    reserveUse(tenantId: string, grantId: string, authorizationKey: string, at: string) {
      return Promise.resolve().then(() => {
        const stored = getGrant(tenantId, grantId);
        if (stored === undefined) throw new GrantError("KAF_POLICY_GRANT_MISSING");
        const replay = stored.claims.get(authorizationKey);
        if (replay !== undefined) return replay;
        if (stored.revokedAt !== undefined || stored.grant.revokedAt !== undefined) {
          throw new GrantError("KAF_POLICY_GRANT_REVOKED");
        }
        if (Date.parse(at) >= Date.parse(stored.grant.expiresAt)) {
          throw new GrantError("KAF_POLICY_GRANT_EXPIRED");
        }
        if (stored.claims.size >= stored.grant.maximumUses) {
          throw new GrantError("KAF_POLICY_GRANT_EXHAUSTED");
        }
        const claim = Object.freeze({
          schemaVersion: "1" as const,
          grantId,
          authorizationKey,
          useNumber: stored.claims.size + 1,
          claimedAt: at,
        });
        stored.claims.set(authorizationKey, claim);
        return claim;
      });
    },
  };
  return Object.freeze(store);
}
