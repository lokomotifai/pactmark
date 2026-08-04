import {
  CapabilityGrantBindingSchema,
  CapabilityGrantSchema,
  KafError,
  canonicalJsonStringify,
  digestCanonicalJson,
  type CapabilityGrant,
  type CapabilityGrantBinding,
  type CapabilityGrantResolution,
  type CapabilityGrantStore,
  type CapabilityGrantUseClaim,
  type DurableWakeupReceipt,
  type DurableWakeupRequest,
} from "@pactmark/core";

import { cloneJson, conflict, recordKey, sameJson } from "./internal.js";

export class MemoryCapabilityGrantStore implements CapabilityGrantStore {
  #grants = new Map<string, CapabilityGrant>();
  #claims = new Map<string, Readonly<{ tenantId: string; claim: CapabilityGrantUseClaim }>>();

  async issue(input: CapabilityGrant): Promise<void> {
    await Promise.resolve();
    const grant = CapabilityGrantSchema.parse(input);
    const key = recordKey(grant.tenant.id, grant.id);
    const existing = this.#grants.get(key);
    if (existing !== undefined) {
      if (sameJson(existing, grant)) return;
      conflict("capability_grant_changed");
    }
    this.#grants.set(key, cloneJson(grant));
  }

  async revoke(tenantId: string, grantId: string, revokedAt: string): Promise<void> {
    await Promise.resolve();
    const key = recordKey(tenantId, grantId);
    const grant = this.#grants.get(key);
    if (grant === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    this.#grants.set(key, CapabilityGrantSchema.parse({ ...grant, revokedAt }));
  }

  async resolve(
    grantId: string,
    bindingInput: CapabilityGrantBinding,
    at: string,
  ): Promise<CapabilityGrantResolution> {
    await Promise.resolve();
    const binding = CapabilityGrantBindingSchema.parse(bindingInput);
    const grant = this.#grants.get(recordKey(binding.tenant.id, grantId));
    if (grant === undefined) return { status: "missing" };
    if (canonicalJsonStringify(binding) !== canonicalJsonStringify(projectBinding(grant))) {
      return { status: "binding_mismatch" };
    }
    if (grant.revokedAt !== undefined) return { status: "revoked" };
    if (Date.parse(grant.expiresAt) <= Date.parse(at)) return { status: "expired" };
    const uses = [...this.#claims.values()].filter(
      ({ tenantId, claim }) => tenantId === grant.tenant.id && claim.grantId === grant.id,
    ).length;
    const usesRemaining = grant.maximumUses - uses;
    return usesRemaining <= 0
      ? { status: "exhausted" }
      : { status: "active", grant: cloneJson(grant), usesRemaining };
  }

  async reserveUse(
    grantId: string,
    authorizationKey: string,
    at: string,
  ): Promise<CapabilityGrantUseClaim> {
    const tenants = new Set(
      [...this.#grants.values()].filter(({ id }) => id === grantId).map(({ tenant }) => tenant.id),
    );
    if (tenants.size !== 1) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "capability_grant_tenant_ambiguous" },
      });
    }
    const tenantId = [...tenants][0];
    if (tenantId === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    return this.reserveUseForTenant(tenantId, grantId, authorizationKey, at);
  }

  async reserveUseForTenant(
    tenantId: string,
    grantId: string,
    authorizationKey: string,
    at: string,
  ): Promise<CapabilityGrantUseClaim> {
    await Promise.resolve();
    const claimKey = recordKey(tenantId, grantId, authorizationKey);
    const existing = this.#claims.get(claimKey);
    if (existing !== undefined) return cloneJson(existing.claim);
    const grant = this.#grants.get(recordKey(tenantId, grantId));
    if (
      grant === undefined ||
      grant.revokedAt !== undefined ||
      Date.parse(grant.expiresAt) <= Date.parse(at)
    ) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "capability_grant_unavailable" },
      });
    }
    const useNumber =
      [...this.#claims.values()].filter(
        ({ tenantId: claimTenantId, claim }) =>
          claimTenantId === tenantId && claim.grantId === grantId,
      ).length + 1;
    if (useNumber > grant.maximumUses) {
      throw new KafError("KAF_AUTHORIZATION_BINDING_MISMATCH", {
        details: { reason: "capability_grant_exhausted" },
      });
    }
    const claim = {
      schemaVersion: "1" as const,
      grantId,
      authorizationKey,
      useNumber,
      claimedAt: at,
    };
    this.#claims.set(claimKey, { tenantId, claim });
    return cloneJson(claim);
  }

  snapshot() {
    return { grants: structuredClone(this.#grants), claims: structuredClone(this.#claims) };
  }

  restore(snapshot: ReturnType<MemoryCapabilityGrantStore["snapshot"]>): void {
    this.#grants = snapshot.grants;
    this.#claims = snapshot.claims;
  }
}

export class MemoryWakeupQueue {
  #requests = new Map<
    string,
    Readonly<{ request: DurableWakeupRequest; receipt: DurableWakeupReceipt }>
  >();

  constructor(
    readonly now: () => string = () => new Date().toISOString(),
    readonly generateId: (digest: string) => string = (digest) => `wakeup-${digest.slice(7, 39)}`,
  ) {}

  async enqueue(request: DurableWakeupRequest): Promise<DurableWakeupReceipt> {
    await Promise.resolve();
    const key = recordKey(request.tenantId, request.deduplicationKey);
    const existing = this.#requests.get(key);
    if (existing !== undefined) {
      if (sameJson(existing.request, request)) return cloneJson(existing.receipt);
      conflict("wakeup_deduplication_changed");
    }
    const digest = digestCanonicalJson(request);
    const receipt = {
      schemaVersion: "1" as const,
      receiptId: this.generateId(digest),
      requestDigest: digest,
      enqueuedAt: this.now(),
    };
    this.#requests.set(key, { request: cloneJson(request), receipt });
    return cloneJson(receipt);
  }

  snapshot() {
    return structuredClone(this.#requests);
  }

  restore(snapshot: ReturnType<MemoryWakeupQueue["snapshot"]>): void {
    this.#requests = snapshot;
  }

  get size(): number {
    return this.#requests.size;
  }
}

function projectBinding(grant: CapabilityGrant): CapabilityGrantBinding {
  return CapabilityGrantBindingSchema.parse(grant);
}
