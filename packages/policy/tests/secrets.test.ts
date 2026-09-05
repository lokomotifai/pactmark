import {
  SecretResolutionBindingSchema,
  ToolCredentialIssueRequestSchema,
  type Clock,
  type IdGenerator,
} from "@pactmark/core";
import { describe, expect, it } from "vitest";

import { SecretBoundaryError, createMemoryToolCredentialBoundary } from "../src/index.js";
import { digest } from "./fixtures.js";

const clock: Clock = {
  now: () => "2026-08-03T10:00:00.000Z",
  monotonicMilliseconds: () => 0,
};
const ids: IdGenerator = { generate: () => "opaque-ref-1" };
const canary = "registered-secret-canary-very-sensitive";

function issueRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return ToolCredentialIssueRequestSchema.parse({
    schemaVersion: "1",
    tenantId: "tenant-1",
    authoritySubject: "user-1",
    workOrderBindingDigest: digest("1"),
    executionDefinitionKind: "agent",
    executionDefinitionDigest: digest("2"),
    grantId: "grant-1",
    toolId: "demo.action@1",
    toolVersion: "1",
    toolRegistrationDigest: digest("3"),
    credentialSlot: "publisher.api-key",
    normalizedDestinationDigest: digest("4"),
    effectDigest: digest("5"),
    purpose: "service_delivery",
    maximumUses: 1,
    expiresAt: "2026-08-03T10:10:00.000Z",
    ...overrides,
  });
}

function boundary(authorizeIssue = true) {
  return createMemoryToolCredentialBoundary({
    issuerId: "credential-issuer@1",
    resolverId: "credential-resolver@1",
    clock,
    idGenerator: ids,
    slots: [
      {
        slot: "publisher.api-key",
        value: canary,
        allowedToolRegistrationDigests: [digest("3")],
        allowedDestinationDigests: [digest("4")],
        allowedPurposes: ["service_delivery"],
        allowedExecutionKinds: ["agent"],
      },
    ],
    authorizeIssue: () => authorizeIssue,
  });
}

function resolutionBinding(overrides: Readonly<Record<string, unknown>> = {}) {
  return SecretResolutionBindingSchema.parse({
    schemaVersion: "1",
    authorizationReservationId: "authorization-1",
    tenantId: "tenant-1",
    workOrderBindingDigest: digest("1"),
    executionDefinitionDigest: digest("2"),
    grantId: "grant-1",
    toolRegistrationDigest: digest("3"),
    credentialSlot: "publisher.api-key",
    normalizedDestinationDigest: digest("4"),
    effectDigest: digest("5"),
    ...overrides,
  });
}

describe("one-use SecretRef boundary", () => {
  it("keeps the value out of metadata and reveals it only to an adapter callback", async () => {
    const service = boundary();
    const ref = await service.issuer.issue(issueRequest());
    await service.store.putImmutable(ref);
    expect(JSON.stringify(ref)).not.toContain(canary);
    const credential = await service.resolver.resolve(ref, resolutionBinding());
    expect(credential.use((value) => value)).toBe(canary);
    expect(() => JSON.stringify(credential)).toThrow(/SERIALIZATION_FORBIDDEN/u);
    await expect(service.resolver.resolve(ref, resolutionBinding())).resolves.toBeDefined();
  });

  it.each([
    ["tenant", { tenantId: "tenant-2" }],
    ["work-order", { workOrderBindingDigest: digest("a") }],
    ["execution", { executionDefinitionDigest: digest("a") }],
    ["grant", { grantId: "grant-2" }],
    ["tool", { toolRegistrationDigest: digest("a") }],
    ["slot", { credentialSlot: "other.slot" }],
    ["destination", { normalizedDestinationDigest: digest("a") }],
    ["effect", { effectDigest: digest("a") }],
  ])("rejects a cross-binding resolution for %s", async (_name, changed) => {
    const service = boundary();
    const ref = await service.issuer.issue(issueRequest());
    await service.store.putImmutable(ref);
    await expect(service.resolver.resolve(ref, resolutionBinding(changed))).rejects.toBeInstanceOf(
      SecretBoundaryError,
    );
  });

  it("rejects unauthorized, unregistered, expired, cross-kind, exhausted, and revoked refs", async () => {
    await expect(boundary(false).issuer.issue(issueRequest())).rejects.toBeInstanceOf(
      SecretBoundaryError,
    );
    await expect(
      boundary().issuer.issue(issueRequest({ credentialSlot: "unknown.slot" })),
    ).rejects.toBeInstanceOf(SecretBoundaryError);
    await expect(
      boundary().issuer.issue(issueRequest({ expiresAt: "2026-08-03T10:00:00.000Z" })),
    ).rejects.toBeInstanceOf(SecretBoundaryError);
    await expect(
      boundary().issuer.issue(issueRequest({ executionDefinitionKind: "compensation" })),
    ).rejects.toBeInstanceOf(SecretBoundaryError);

    const service = boundary();
    const ref = await service.issuer.issue(issueRequest());
    await service.store.putImmutable(ref);
    await service.resolver.resolve(ref, resolutionBinding());
    await expect(
      service.resolver.resolve(
        ref,
        resolutionBinding({ authorizationReservationId: "authorization-2" }),
      ),
    ).rejects.toBeInstanceOf(SecretBoundaryError);
    await service.store.revoke(ref.tenantId, ref.refId, "2026-08-03T10:01:00.000Z");
    await expect(service.resolver.resolve(ref, resolutionBinding())).rejects.toBeInstanceOf(
      SecretBoundaryError,
    );
  });

  it("rejects immutable metadata replacement and cross-tenant store access", async () => {
    const service = boundary();
    const ref = await service.issuer.issue(issueRequest());
    await service.store.putImmutable(ref);
    await expect(service.store.get("tenant-2", ref.refId)).resolves.toBeUndefined();
    await expect(service.store.putImmutable({ ...ref, grantId: "grant-2" })).rejects.toBeInstanceOf(
      SecretBoundaryError,
    );
    await expect(
      service.store.revoke("tenant-2", ref.refId, "2026-08-03T10:01:00.000Z"),
    ).rejects.toBeInstanceOf(SecretBoundaryError);
  });

  it("isolates equal ref IDs, use budgets, and delimiter-colliding store keys by tenant", async () => {
    const service = boundary();
    const tenantARef = await service.issuer.issue(issueRequest());
    const tenantBRef = await service.issuer.issue(issueRequest({ tenantId: "tenant-2" }));
    await service.store.putImmutable(tenantARef);
    await service.store.putImmutable(tenantBRef);
    await expect(service.resolver.resolve(tenantARef, resolutionBinding())).resolves.toBeDefined();
    await expect(
      service.resolver.resolve(tenantBRef, resolutionBinding({ tenantId: "tenant-2" })),
    ).resolves.toBeDefined();

    const delimiterA = { ...tenantARef, tenantId: "a:b", refId: "c" };
    const delimiterB = { ...tenantARef, tenantId: "a", refId: "b:c" };
    await service.store.putImmutable(delimiterA);
    await service.store.putImmutable(delimiterB);
    await expect(service.store.get("a:b", "c")).resolves.toEqual(delimiterA);
    await expect(service.store.get("a", "b:c")).resolves.toEqual(delimiterB);
    await service.store.revoke("a:b", "c", "2026-08-03T10:01:00.000Z");
    await expect(service.store.get("a", "b:c")).resolves.toEqual(delimiterB);
  });
});
