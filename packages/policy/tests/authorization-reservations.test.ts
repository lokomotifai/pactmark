import { AuthorizationReservationSchema } from "@pactmark/core";
import { describe, expect, it } from "vitest";

import {
  AuthorizationReservationError,
  createMemoryAuthorizationReservationStore,
} from "../src/index.js";
import { digest, makeInput, workOrder } from "./fixtures.js";

function reservation(overrides: Readonly<Record<string, unknown>> = {}) {
  const policyInput = makeInput("R4");
  return AuthorizationReservationSchema.parse({
    schemaVersion: "1",
    authorizationReservationId: "authorization-1",
    authorizationKey: "effect-key-1",
    tenantId: workOrder.tenant.id,
    runId: "run-1",
    stepId: "step-1",
    toolCallId: "call-1",
    effectKey: "effect-key-1",
    workOrderBindingDigest: workOrder.workOrderBindingDigest,
    executionDefinition: workOrder.executionDefinition,
    executionDefinitionDigest: workOrder.executionDefinitionDigest,
    toolId: policyInput.tool.id,
    toolVersion: "1",
    toolRegistrationDigest: policyInput.tool.toolRegistrationDigest,
    policyRegistrationDigest: policyInput.policyRegistrationDigest,
    argumentsDigest: digest("7"),
    normalizedTargetDigest: digest("8"),
    grantId: "grant-1",
    approvalId: "approval-1",
    secretRefIds: ["secret-1"],
    purposeCode: workOrder.purpose.code,
    purposeRegistryVersion: workOrder.purpose.registryVersion,
    state: "reserved",
    createdAt: "2026-08-03T10:00:00.000Z",
    expiresAt: "2026-08-03T10:10:00.000Z",
    ...overrides,
  });
}

describe("authorization reservation claims", () => {
  it("claims grant, approval, and SecretRef once and replays the same binding", async () => {
    const store = createMemoryAuthorizationReservationStore({
      grantMaximumUses: () => 1,
      approvalMaximumUses: () => 1,
      secretRefMaximumUses: () => 1,
    });
    const value = reservation();
    const first = await store.reserve(value, "2026-08-03T10:01:00.000Z");
    await expect(store.reserve(value, "2026-08-03T10:02:00.000Z")).resolves.toEqual(first);
    await expect(store.get(value.tenantId, value.authorizationKey)).resolves.toEqual(first);
    const consumed = await store.consume(
      value.tenantId,
      value.authorizationKey,
      "2026-08-03T10:03:00.000Z",
    );
    expect(consumed).toMatchObject({ state: "consumed" });
    await expect(
      store.consume(value.tenantId, value.authorizationKey, "2026-08-03T10:04:00.000Z"),
    ).resolves.toEqual(consumed);
  });

  it("rejects changed same-key binding and different-key one-use replay", async () => {
    const store = createMemoryAuthorizationReservationStore({
      grantMaximumUses: () => 1,
      approvalMaximumUses: () => 1,
      secretRefMaximumUses: () => 1,
    });
    await store.reserve(reservation(), "2026-08-03T10:01:00.000Z");
    await expect(
      store.reserve(reservation({ argumentsDigest: digest("9") }), "2026-08-03T10:02:00.000Z"),
    ).rejects.toBeInstanceOf(AuthorizationReservationError);
    await expect(
      store.reserve(
        reservation({
          authorizationReservationId: "authorization-2",
          authorizationKey: "effect-key-2",
          effectKey: "effect-key-2",
          toolCallId: "call-2",
        }),
        "2026-08-03T10:02:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "KAF_POLICY_AUTHORIZATION_CLAIM_EXHAUSTED" });
  });

  it("fails closed for expired, missing-limit, duplicate-ID, and missing reservations", async () => {
    const store = createMemoryAuthorizationReservationStore({
      grantMaximumUses: (_tenantId, id) => (id === "grant-1" ? 2 : undefined),
      approvalMaximumUses: () => 2,
      secretRefMaximumUses: () => 2,
    });
    await expect(store.reserve(reservation(), "2026-08-03T10:10:00.000Z")).rejects.toMatchObject({
      code: "KAF_POLICY_AUTHORIZATION_EXPIRED",
    });
    await expect(
      store.reserve(reservation({ grantId: "unknown" }), "2026-08-03T10:01:00.000Z"),
    ).rejects.toMatchObject({ code: "KAF_POLICY_AUTHORIZATION_CLAIM_EXHAUSTED" });
    await store.reserve(reservation(), "2026-08-03T10:01:00.000Z");
    await expect(
      store.reserve(
        reservation({ authorizationKey: "key-2", effectKey: "key-2" }),
        "2026-08-03T10:02:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "KAF_POLICY_AUTHORIZATION_DUPLICATE" });
    await expect(
      store.consume("tenant-1", "missing", "2026-08-03T10:02:00.000Z"),
    ).rejects.toMatchObject({ code: "KAF_POLICY_AUTHORIZATION_BINDING_MISMATCH" });
    await expect(
      store.consume("tenant-1", "effect-key-1", "2026-08-03T10:10:00.000Z"),
    ).rejects.toMatchObject({ code: "KAF_POLICY_AUTHORIZATION_EXPIRED" });
  });

  it("supports read reservations without approval or credential claims", async () => {
    const store = createMemoryAuthorizationReservationStore({
      grantMaximumUses: () => 2,
      secretRefMaximumUses: () => undefined,
    });
    await expect(
      store.reserve(
        reservation({ approvalId: undefined, secretRefIds: [] }),
        "2026-08-03T10:01:00.000Z",
      ),
    ).resolves.toMatchObject({ state: "reserved", secretRefIds: [] });
  });

  it("does not leave a partial grant claim when the approval claim fails", async () => {
    const store = createMemoryAuthorizationReservationStore({
      grantMaximumUses: () => 2,
      approvalMaximumUses: () => 1,
      secretRefMaximumUses: () => 2,
    });
    await store.reserve(reservation(), "2026-08-03T10:01:00.000Z");
    await expect(
      store.reserve(
        reservation({
          authorizationReservationId: "authorization-2",
          authorizationKey: "effect-key-2",
          effectKey: "effect-key-2",
          toolCallId: "call-2",
          grantId: "grant-2",
        }),
        "2026-08-03T10:02:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "KAF_POLICY_AUTHORIZATION_CLAIM_EXHAUSTED" });
    await expect(
      store.reserve(
        reservation({
          authorizationReservationId: "authorization-3",
          authorizationKey: "effect-key-3",
          effectKey: "effect-key-3",
          toolCallId: "call-3",
          grantId: "grant-2",
          approvalId: "approval-2",
          secretRefIds: [],
        }),
        "2026-08-03T10:03:00.000Z",
      ),
    ).resolves.toMatchObject({ authorizationReservationId: "authorization-3" });
  });

  it("isolates delimiter-colliding keys and equal claim IDs between tenants", async () => {
    const observedGrantLookups: string[] = [];
    const store = createMemoryAuthorizationReservationStore({
      grantMaximumUses: (tenantId) => {
        observedGrantLookups.push(tenantId);
        return 1;
      },
      approvalMaximumUses: () => 1,
      secretRefMaximumUses: () => 1,
    });
    const tenantA = reservation({
      tenantId: "a:b",
      authorizationKey: "c",
      effectKey: "c",
    });
    const tenantB = reservation({
      tenantId: "a",
      authorizationKey: "b:c",
      effectKey: "b:c",
    });
    await expect(store.reserve(tenantA, "2026-08-03T10:01:00.000Z")).resolves.toEqual(tenantA);
    await expect(store.reserve(tenantB, "2026-08-03T10:01:00.000Z")).resolves.toEqual(tenantB);
    await expect(store.get("a:b", "c")).resolves.toEqual(tenantA);
    await expect(store.get("a", "b:c")).resolves.toEqual(tenantB);
    expect(observedGrantLookups).toEqual(["a:b", "a"]);
  });
});
