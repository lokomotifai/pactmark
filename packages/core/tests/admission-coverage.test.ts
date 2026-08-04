import { ActiveExecutionReservationSchema, CircuitBreakerStateSchema } from "../src/admission.js";
import { createCommandId } from "../src/commands.js";
import { protectedEffectResultAad, type ProtectedEffectResultAadRecord } from "../src/effects.js";
import { ModelCallReservationSchema, ModelCallSettlementSchema } from "../src/model.js";
import { defineSchema, schemaIdentityDigest } from "../src/schema-identity.js";
import { canonicalJsonStringify, digestBytes, digestCanonicalJson } from "../src/serialization.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const now = "2026-08-03T10:00:00.000Z";
const later = "2026-08-03T10:01:00.000Z";
const digest = (value: string) => digestBytes(new TextEncoder().encode(value));

const active = {
  schemaVersion: "1" as const,
  id: "active-1",
  tenant: { id: "tenant-a" },
  runId: "run-1",
  stepId: "step-1",
  boundary: "model" as const,
  boundaryKey: "model-1",
  leaseId: "lease-1",
  fencingToken: 1,
  startedAtServerTime: now,
  maxChargeMs: 100,
  state: "reserved" as const,
  expiresAt: later,
};

const circuit = {
  schemaVersion: "1" as const,
  tenantId: "tenant-a",
  providerKey: "provider-a",
  state: "closed" as const,
  failureCount: 0,
  updatedAt: now,
};

describe("admission schema invariant branch coverage", () => {
  it("accepts only complete and balanced active-execution settlements", () => {
    expect(ActiveExecutionReservationSchema.safeParse(active).success).toBe(true);
    for (const settlement of [
      { settledChargeMs: 1 },
      { refundedMs: 1 },
      { settledAtServerTime: now },
    ]) {
      expect(ActiveExecutionReservationSchema.safeParse({ ...active, ...settlement }).success).toBe(
        false,
      );
    }

    for (const incomplete of [
      {},
      { settledChargeMs: 40 },
      { settledChargeMs: 40, refundedMs: 60 },
      { settledChargeMs: 40, refundedMs: 59, settledAtServerTime: now },
    ]) {
      expect(
        ActiveExecutionReservationSchema.safeParse({
          ...active,
          state: "settled",
          ...incomplete,
        }).success,
      ).toBe(false);
    }

    expect(
      ActiveExecutionReservationSchema.safeParse({
        ...active,
        state: "settled",
        settledChargeMs: 40,
        refundedMs: 60,
        settledAtServerTime: now,
      }).success,
    ).toBe(true);
    expect(
      ActiveExecutionReservationSchema.safeParse({
        ...active,
        state: "closed_uncertain",
        settledChargeMs: 40,
        refundedMs: 60,
        settledAtServerTime: now,
      }).success,
    ).toBe(false);
    expect(
      ActiveExecutionReservationSchema.safeParse({
        ...active,
        state: "closed_uncertain",
        settledChargeMs: 100,
        refundedMs: 0,
        settledAtServerTime: now,
      }).success,
    ).toBe(true);
  });

  it("requires the half-open probe lease and fencing token as one state-bound pair", () => {
    expect(CircuitBreakerStateSchema.safeParse(circuit).success).toBe(true);
    for (const invalid of [
      { probeLeaseId: "probe-1" },
      { probeFencingToken: 1 },
      { probeLeaseId: "probe-1", probeFencingToken: 1 },
      { state: "half_open" },
      { state: "half_open", probeLeaseId: "probe-1" },
      { state: "half_open", probeFencingToken: 1 },
    ]) {
      expect(CircuitBreakerStateSchema.safeParse({ ...circuit, ...invalid }).success).toBe(false);
    }
    expect(
      CircuitBreakerStateSchema.safeParse({
        ...circuit,
        state: "half_open",
        probeLeaseId: "probe-1",
        probeFencingToken: 1,
      }).success,
    ).toBe(true);
  });
});

describe("resource reservation contract branch coverage", () => {
  const settlement = {
    schemaVersion: "1" as const,
    inputBytes: 100,
    inputTokenLowerBound: 10,
    outputBytes: 50,
    outputTokenLowerBound: 5,
    chargedTokens: 15,
    chargedIoBytes: 150,
    settledAt: now,
  };
  const model = {
    schemaVersion: "1" as const,
    reservationId: "model-1",
    tenantId: "tenant-a",
    runId: "run-1",
    stepId: "step-1",
    attempt: 1,
    workOrderBindingDigest: digest("work"),
    agentDefinitionDigest: digest("agent"),
    modelSecurityProfileDigest: digest("security"),
    modelResourceProfileDigest: digest("resource"),
    modelAdapterRegistrationDigest: digest("adapter"),
    inputBytes: 100,
    inputTokenUpperBound: 20,
    outputTokenMaximum: 30,
    outputBytesMaximum: 200,
    status: "accepted" as const,
    expiresAt: later,
    createdAt: now,
  };

  it("binds cost/currency pairs and settlement presence", () => {
    expect(ModelCallSettlementSchema.safeParse(settlement).success).toBe(true);
    expect(
      ModelCallSettlementSchema.safeParse({ ...settlement, chargedCostMinor: 1 }).success,
    ).toBe(false);
    expect(ModelCallSettlementSchema.safeParse({ ...settlement, currency: "USD" }).success).toBe(
      false,
    );
    expect(
      ModelCallSettlementSchema.safeParse({
        ...settlement,
        chargedCostMinor: 1,
        currency: "USD",
      }).success,
    ).toBe(true);

    expect(ModelCallReservationSchema.safeParse(model).success).toBe(true);
    expect(
      ModelCallReservationSchema.safeParse({ ...model, maximumCallCostMinor: 1 }).success,
    ).toBe(false);
    expect(ModelCallReservationSchema.safeParse({ ...model, currency: "USD" }).success).toBe(false);
    expect(ModelCallReservationSchema.safeParse({ ...model, settlement }).success).toBe(false);
    expect(ModelCallReservationSchema.safeParse({ ...model, status: "settled" }).success).toBe(
      false,
    );
    expect(
      ModelCallReservationSchema.safeParse({ ...model, status: "settled", settlement }).success,
    ).toBe(true);
  });

  it("materializes every protected effect-result AAD field", () => {
    const executionDefinition = {
      kind: "agent" as const,
      id: "agent-a",
      version: "1.0.0",
      agentDefinitionDigest: digest("agent-definition"),
    };
    const material: ProtectedEffectResultAadRecord = {
      schemaVersion: "1",
      tenantId: "tenant-a",
      runId: "run-1",
      effectId: "effect-1",
      effectDigest: digest("effect"),
      resultDigest: digestCanonicalJson({ ok: true }),
      byteSize: 11,
      workOrderId: "work-order-1",
      workOrderBindingDigest: digest("work-order"),
      executionDefinition,
      executionDefinitionDigest: digestCanonicalJson(executionDefinition),
      toolId: "demo.write",
      toolVersion: "1.0.0",
      toolRegistrationDigest: digest("tool"),
      strategy: "native",
      strategyRegistrationDigest: digest("strategy"),
      resultSchemaDigest: digest("result-schema"),
      purposeCode: "support",
      purposeRegistryVersion: "1",
      dataClass: "internal",
      createdAt: now,
    };
    expect(protectedEffectResultAad(material)).toMatchObject({
      recordId: "effect-1",
      byteSize: "11",
      dataClass: "internal",
    });
  });

  it("rejects non-finite and oversized command clocks and preserves surrogate pairs", () => {
    const randomBytes = () => new Uint8Array(16);
    expect(() => createCommandId({ now: () => new Date(Number.NaN), randomBytes })).toThrow(
      RangeError,
    );
    expect(() => createCommandId({ now: () => new Date(10_000_000_000_000), randomBytes })).toThrow(
      RangeError,
    );
    expect(canonicalJsonStringify("😀")).toBe('"😀"');
  });

  it("rejects a schema identity whose claimed digest differs from its material", () => {
    const defined = defineSchema({
      id: "coverage.schema",
      semanticRevision: "1",
      schema: z.object({ value: z.string() }).strict(),
    });
    expect(() =>
      schemaIdentityDigest({ ...defined.identity, schemaIdentityDigest: digest("wrong") }),
    ).toThrow("SchemaIdentity digest does not match");
  });
});
