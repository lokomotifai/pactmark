import {
  KafError,
  canonicalJsonStringify,
  digestBytes,
  digestCanonicalJson,
  protectedEffectResultAad,
  type DataProtector,
  type EffectRecord,
  type JsonValue,
  type ProtectedEffectResultAadRecord,
  type ProtectedEffectResultRecord,
  type ProtectedValueRef,
} from "@pactmark/core";
import { describe, expect, it } from "vitest";

import {
  MemoryAcknowledgedEffectResultStore,
  createMemoryStorageSecurityProfile,
  createMemoryStoreSuite,
} from "../src/index.js";

const instant = "2026-08-03T10:00:00.000Z";
const d = (value: string) => digestBytes(new TextEncoder().encode(value));
const executionDefinition = {
  kind: "agent" as const,
  id: "support-agent",
  version: "1.0.0",
  agentDefinitionDigest: d("agent"),
};
const executionDefinitionDigest = digestCanonicalJson(executionDefinition);
const result: JsonValue = { receipt: "PLAINTEXT-EFFECT-RESULT-CANARY" };
const resultBytes = new TextEncoder().encode(canonicalJsonStringify(result));

function acknowledgedEffect(
  overrides: Partial<EffectRecord> = {},
): Extract<EffectRecord, { state: "acknowledged" }> {
  const tenantId = overrides.tenantId ?? "tenant-a";
  const runId = overrides.runId ?? "run-1";
  const effectId = overrides.effectId ?? "effect-1";
  const identity = {
    schemaVersion: "1" as const,
    effectId,
    tenantId,
    runId,
    stepId: "step-1",
    toolCallId: "call-1",
    effectKey: `${tenantId}:${effectId}`,
    operationKey: `${tenantId}:operation:${effectId}`,
    executionDefinition,
    executionDefinitionDigest,
    workOrderBindingDigest: d(`${tenantId}:work-order`),
    toolId: "demo.write@1",
    toolVersion: "1.0.0",
    toolRegistrationDigest: d("tool"),
    strategy: "native" as const,
    strategyRegistrationDigest: d("strategy"),
    authorizationReservationId: `${tenantId}:authorization:${effectId}`,
    argumentsDigest: d("arguments"),
    normalizedTargetDigest: d("target"),
    createdAt: instant,
  };
  const resultDigest = digestCanonicalJson(result);
  return {
    ...identity,
    effectDigest: digestCanonicalJson(identity),
    state: "acknowledged",
    resultDigest,
    acknowledgement: {
      schemaVersion: "1",
      acknowledgementId: `${tenantId}:ack:${effectId}`,
      proofKind: "receiver_receipt",
      effectKey: identity.effectKey,
      operationKey: identity.operationKey,
      toolRegistrationDigest: identity.toolRegistrationDigest,
      strategyRegistrationDigest: identity.strategyRegistrationDigest,
      normalizedTargetDigest: identity.normalizedTargetDigest,
      resultSchemaDigest: d("result-schema"),
      resultDigest,
      proofDigest: d("proof"),
      acknowledgedAt: instant,
    },
    updatedAt: instant,
    ...overrides,
  } as Extract<EffectRecord, { state: "acknowledged" }>;
}

async function protectedResult(
  protector: TestProtector,
  effect = acknowledgedEffect(),
  overrides: Partial<ProtectedEffectResultAadRecord> = {},
): Promise<ProtectedEffectResultRecord> {
  const material: ProtectedEffectResultAadRecord = {
    schemaVersion: "1",
    tenantId: effect.tenantId,
    runId: effect.runId,
    effectId: effect.effectId,
    effectDigest: effect.effectDigest,
    resultDigest: effect.resultDigest,
    byteSize: resultBytes.byteLength,
    workOrderId: "work-order-1",
    workOrderBindingDigest: effect.workOrderBindingDigest,
    executionDefinition: effect.executionDefinition,
    executionDefinitionDigest: effect.executionDefinitionDigest,
    toolId: effect.toolId,
    toolVersion: effect.toolVersion,
    toolRegistrationDigest: effect.toolRegistrationDigest,
    strategy: effect.strategy,
    strategyRegistrationDigest: effect.strategyRegistrationDigest,
    resultSchemaDigest: effect.acknowledgement.resultSchemaDigest,
    purposeCode: "support",
    purposeRegistryVersion: "1",
    dataClass: "internal",
    createdAt: effect.updatedAt,
    ...overrides,
  };
  return {
    ...material,
    protectedValue: await protector.protect(protectedEffectResultAad(material), resultBytes),
  };
}

describe("protected acknowledged effect results in memory", () => {
  it("decrypts an exact tenant/effect-bound result and accepts a fresh-ciphertext replay", async () => {
    const protector = new TestProtector();
    const store = new MemoryAcknowledgedEffectResultStore(profile(), protector);
    const effect = acknowledgedEffect();
    const first = await protectedResult(protector, effect);
    const replay = await protectedResult(protector, effect);
    expect(replay.protectedValue.ciphertextRef).not.toBe(first.protectedValue.ciphertextRef);
    await store.putImmutable(first);
    await store.putImmutable(replay);
    await expect(store.getAcknowledgedResult(effect)).resolves.toEqual(result);
    await expect(
      store.getAcknowledgedResult(acknowledgedEffect({ tenantId: "tenant-b" })),
    ).resolves.toBeUndefined();
  });

  it("scopes protected-reference uniqueness by tenant but rejects same-tenant reuse", async () => {
    const protector = new TestProtector();
    const store = new MemoryAcknowledgedEffectResultStore(profile(), protector);
    const tenantA = await protectedResult(protector);
    const tenantBEffect = acknowledgedEffect({ tenantId: "tenant-b" });
    const tenantB = await protectedResult(protector, tenantBEffect, {
      workOrderBindingDigest: tenantBEffect.workOrderBindingDigest,
    });
    const sharedReference = tenantA.protectedValue;
    await store.putImmutable(tenantA);
    await expect(
      store.putImmutable({ ...tenantB, protectedValue: sharedReference }),
    ).resolves.toBeUndefined();
    await expect(store.getAcknowledgedResult(acknowledgedEffect())).resolves.toEqual(result);
    const secondEffect = acknowledgedEffect({ effectId: "effect-2" });
    const second = await protectedResult(protector, secondEffect);
    await expect(
      store.putImmutable({ ...second, protectedValue: sharedReference }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
  });

  it("fails closed for wrong AAD, result digest, byte size, and noncanonical JSON", async () => {
    const protector = new TestProtector();
    const effect = acknowledgedEffect();
    const base = await protectedResult(protector, effect);

    const wrongAad = new MemoryAcknowledgedEffectResultStore(profile(), protector);
    await wrongAad.putImmutable({ ...base, purposeCode: "other" });
    await expect(wrongAad.getAcknowledgedResult(effect)).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
    });

    const wrongDigest = new MemoryAcknowledgedEffectResultStore(profile(), protector);
    await wrongDigest.putImmutable({ ...base, resultDigest: d("wrong") });
    await expect(wrongDigest.getAcknowledgedResult(effect)).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
    const wrongSize = new MemoryAcknowledgedEffectResultStore(profile(), protector);
    await wrongSize.putImmutable({ ...base, byteSize: base.byteSize + 1 });
    await expect(wrongSize.getAcknowledgedResult(effect)).rejects.toMatchObject({
      code: "KAF_STORAGE_SECURITY_PROFILE",
    });

    const noncanonicalProtector = new TestProtector();
    const noncanonical = new TextEncoder().encode('{"receipt" : "PLAINTEXT-EFFECT-RESULT-CANARY"}');
    const { protectedValue: _oldReference, ...baseMaterial } = base;
    void _oldReference;
    const material = { ...baseMaterial, byteSize: noncanonical.byteLength };
    const protectedValue = await noncanonicalProtector.protect(
      protectedEffectResultAad(material),
      noncanonical,
    );
    const store = new MemoryAcknowledgedEffectResultStore(profile(), noncanonicalProtector);
    await store.putImmutable({ ...material, protectedValue });
    await expect(store.getAcknowledgedResult(effect)).rejects.toMatchObject({
      code: "KAF_STORAGE_CONCURRENCY_CONFLICT",
    });
  });

  it("rolls back acknowledged effect plus result together and rejects unbound work-order metadata", async () => {
    const protector = new TestProtector();
    const suite = createMemoryStoreSuite({
      dataProtector: protector,
      allowedDataClasses: ["internal"],
    });
    const effect = acknowledgedEffect();
    const record = await protectedResult(protector, effect);
    await expect(
      suite.runCommandUnitOfWork.transactTransition(
        {
          schemaVersion: "1",
          tenantId: "tenant-a",
          runId: "run-1",
          transitionKind: "EffectAcknowledged",
          transitionKey: "effect-1:acknowledged",
          workOrderBindingDigest: effect.workOrderBindingDigest,
          executionDefinitionDigest,
        },
        async (transaction) => {
          await transaction.putProtectedEffectResult(record);
          throw new Error("unreachable");
        },
      ),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      suite.acknowledgedEffectResultStore.getAcknowledgedResult(effect),
    ).resolves.toBeUndefined();
  });
});

function profile() {
  return createMemoryStorageSecurityProfile({
    allowedTenants: ["tenant-a", "tenant-b"],
    allowedPurposes: ["support", "other"],
    allowedDataClasses: ["internal"],
  });
}

class TestProtector implements DataProtector {
  readonly #values = new Map<string, Uint8Array>();
  #counter = 0;

  async protect(
    binding: Readonly<Record<string, string>>,
    plaintext: Uint8Array,
  ): Promise<ProtectedValueRef> {
    await Promise.resolve();
    this.#counter += 1;
    const ciphertextRef = `ciphertext-${String(this.#counter)}`;
    this.#values.set(ciphertextRef, new Uint8Array(plaintext));
    return {
      schemaVersion: "1",
      protectorId: "test",
      keyId: "key-1",
      ciphertextRef,
      ciphertextDigest: digestBytes(plaintext),
      aadDigest: digestCanonicalJson(binding),
      algorithm: "test-only",
    };
  }

  async unprotect(
    binding: Readonly<Record<string, string>>,
    reference: ProtectedValueRef,
  ): Promise<Uint8Array> {
    await Promise.resolve();
    if (reference.aadDigest !== digestCanonicalJson(binding)) {
      throw new KafError("KAF_STORAGE_SECURITY_PROFILE", { details: { reason: "aad_mismatch" } });
    }
    const value = this.#values.get(reference.ciphertextRef);
    if (value === undefined) throw new KafError("KAF_STORAGE_NOT_FOUND");
    return new Uint8Array(value);
  }
}
