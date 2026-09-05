import {
  createAuthorityIssuer,
  type CapabilityGrantBinding,
  type Clock,
  type IdGenerator,
} from "@pactmark/core";
import { describe, expect, it } from "vitest";

import { GrantError, createGrantIssuer, createMemoryCapabilityGrantStore } from "../src/index.js";
import { makeGrant, workOrder } from "./fixtures.js";

const clock: Clock = { now: () => "2026-08-03T10:00:00.000Z", monotonicMilliseconds: () => 0 };
const ids: IdGenerator = { generate: (kind) => `${kind}-issued` };

function bindingOf(grant: ReturnType<typeof makeGrant>): CapabilityGrantBinding {
  return {
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
}

describe("grant issuance and resolution", () => {
  it("issues only from the configured opaque AuthorityContext", async () => {
    const authorityIssuer = createAuthorityIssuer("issuer-1");
    const foreignIssuer = createAuthorityIssuer("issuer-2");
    const claims = {
      actor: workOrder.principal,
      tenant: workOrder.tenant,
      authenticatedAt: "2026-08-03T09:59:00.000Z",
      authenticationStrength: "multi_factor" as const,
      decisionRoles: [],
      requestCorrelationId: "request-1",
      issuedAt: "2026-08-03T09:59:00.000Z",
      expiresAt: "2026-08-03T10:30:00.000Z",
    };
    const issuer = createGrantIssuer({ authorityIssuer, clock, idGenerator: ids });
    const template = makeGrant("R1");
    const request = {
      principal: template.principal,
      tenant: template.tenant,
      workOrderId: template.workOrderId,
      workOrderBindingDigest: template.workOrderBindingDigest,
      executionDefinition: template.executionDefinition,
      executionDefinitionDigest: template.executionDefinitionDigest,
      capability: template.capability,
      action: template.action,
      toolId: template.toolId,
      toolVersion: template.toolVersion,
      toolRegistrationDigest: template.toolRegistrationDigest,
      normalizedResources: template.normalizedResources,
      purpose: template.purpose,
      policyRegistrationDigest: template.policyRegistrationDigest,
      maximumUses: template.maximumUses,
      expiresAt: template.expiresAt,
    };
    await expect(issuer.issue(foreignIssuer.issue(claims), [request])).rejects.toMatchObject({
      code: "KAF_AUTHORITY_INVALID",
    });
    const [issued] = await issuer.issue(authorityIssuer.issue(claims), [request]);
    expect(issued).toMatchObject({ id: "grant-issued", issuerId: "issuer-1" });
    await expect(
      issuer.issue(authorityIssuer.issue(claims), [{ ...request, tenant: { id: "tenant-2" } }]),
    ).rejects.toMatchObject({ code: "KAF_POLICY_GRANT_BINDING_MISMATCH" });
    await expect(
      issuer.issue(authorityIssuer.issue(claims), [
        { ...request, expiresAt: "2026-08-03T09:00:00.000Z" },
      ]),
    ).rejects.toMatchObject({ code: "KAF_POLICY_GRANT_BINDING_MISMATCH" });
  });

  it("resolves full binding, reserves uses idempotently, exhausts, and revokes immediately", async () => {
    const store = createMemoryCapabilityGrantStore();
    const grant = makeGrant("R1");
    await store.issue(grant);
    const binding = bindingOf(grant);
    await expect(
      store.resolve(grant.id, binding, "2026-08-03T10:01:00.000Z"),
    ).resolves.toMatchObject({
      status: "active",
      usesRemaining: 1,
    });
    const first = await store.reserveUse(
      grant.tenant.id,
      grant.id,
      "effect-1",
      "2026-08-03T10:02:00.000Z",
    );
    await expect(
      store.reserveUse(grant.tenant.id, grant.id, "effect-1", "2026-08-03T10:03:00.000Z"),
    ).resolves.toEqual(first);
    await expect(
      store.reserveUse(grant.tenant.id, grant.id, "effect-2", "2026-08-03T10:03:00.000Z"),
    ).rejects.toMatchObject({
      code: "KAF_POLICY_GRANT_EXHAUSTED",
    });
    await expect(
      store.resolve(grant.id, { ...binding, action: "delete" }, "2026-08-03T10:03:00.000Z"),
    ).resolves.toEqual({
      status: "binding_mismatch",
    });
    await store.revoke(grant.tenant.id, grant.id, "2026-08-03T10:04:00.000Z");
    await expect(store.resolve(grant.id, binding, "2026-08-03T10:04:00.000Z")).resolves.toEqual({
      status: "revoked",
    });
  });

  it("rejects expired, duplicate, missing, and cross-tenant records", async () => {
    const store = createMemoryCapabilityGrantStore();
    const grant = makeGrant("R1");
    await store.issue(grant);
    await expect(store.issue(grant)).rejects.toBeInstanceOf(GrantError);
    await expect(
      store.resolve("missing", bindingOf(grant), "2026-08-03T10:00:00.000Z"),
    ).resolves.toEqual({ status: "missing" });
    await expect(store.resolve(grant.id, bindingOf(grant), grant.expiresAt)).resolves.toEqual({
      status: "expired",
    });
    await expect(store.revoke("tenant-2", grant.id, grant.issuedAt)).rejects.toMatchObject({
      code: "KAF_POLICY_GRANT_MISSING",
    });
    await expect(
      store.reserveUse("tenant-2", grant.id, "cross-tenant", grant.issuedAt),
    ).rejects.toMatchObject({ code: "KAF_POLICY_GRANT_MISSING" });
    await expect(
      store.reserveUse(grant.tenant.id, "missing", "key", grant.issuedAt),
    ).rejects.toMatchObject({
      code: "KAF_POLICY_GRANT_MISSING",
    });
    const expiredStore = createMemoryCapabilityGrantStore();
    await expiredStore.issue(grant);
    await expect(
      expiredStore.reserveUse(grant.tenant.id, grant.id, "key", grant.expiresAt),
    ).rejects.toMatchObject({
      code: "KAF_POLICY_GRANT_EXPIRED",
    });
    const revokedStore = createMemoryCapabilityGrantStore();
    await revokedStore.issue(grant);
    await revokedStore.revoke(grant.tenant.id, grant.id, grant.issuedAt);
    await expect(
      revokedStore.reserveUse(grant.tenant.id, grant.id, "key", grant.issuedAt),
    ).rejects.toMatchObject({
      code: "KAF_POLICY_GRANT_REVOKED",
    });
  });

  it("isolates equal grant IDs and use claims between tenants", async () => {
    const store = createMemoryCapabilityGrantStore();
    const tenantAGrant = makeGrant("R1");
    const tenantBGrant = {
      ...tenantAGrant,
      tenant: { id: "tenant-2" },
    };
    await store.issue(tenantAGrant);
    await store.issue(tenantBGrant);
    await expect(
      store.reserveUse("tenant-1", tenantAGrant.id, "same-effect", tenantAGrant.issuedAt),
    ).resolves.toMatchObject({ useNumber: 1 });
    await expect(
      store.reserveUse("tenant-2", tenantBGrant.id, "same-effect", tenantBGrant.issuedAt),
    ).resolves.toMatchObject({ useNumber: 1 });
    await store.revoke("tenant-1", tenantAGrant.id, tenantAGrant.issuedAt);
    await expect(
      store.resolve(tenantBGrant.id, bindingOf(tenantBGrant), tenantBGrant.issuedAt),
    ).resolves.toMatchObject({ status: "exhausted" });
  });
});
