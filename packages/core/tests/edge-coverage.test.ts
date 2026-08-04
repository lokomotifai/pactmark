import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAuthorityIssuer } from "../src/authority.js";
import { createCommandId, validateCommandIdWindow } from "../src/commands.js";
import { KafError, KafPublicErrorSchema, parseWire } from "../src/errors.js";
import {
  DenyAllModelCredentialIssuer,
  DenyAllModelCredentialResolver,
  ModelCredentialDeniedError,
  ResolvedModelCredential,
  ModelCredentialIssueRequestSchema,
} from "../src/model-credential.js";
import { ModelCallReservationSchema, ModelResourceProfileSchema } from "../src/model.js";
import { assertPatternPromotion, PatternManifestSchema } from "../src/patterns.js";
import {
  createToolRegistrationRegistry,
  createVerifierRegistrationRegistry,
  defineModelAdapterRegistration,
  defineToolRegistration,
  defineVerifierRegistration,
} from "../src/registrations.js";
import { defineSchema, parseWithSchema } from "../src/schema-identity.js";
import {
  CanonicalJsonError,
  canonicalJsonStringify,
  parseJsonStrict,
  sha256,
} from "../src/serialization.js";
import {
  DenyAllSecretRefStore,
  DenyAllSecretResolver,
  DenyAllToolCredentialIssuer,
  ResolvedToolCredential,
  ToolCredentialDeniedError,
} from "../src/tool-credential.js";

describe("stable errors and fail-closed credential defaults", () => {
  it("serializes only whitelisted public error fields and wraps schema failures", () => {
    const internal = new Error("private canary");
    const error = new KafError("KAF_POLICY_DENIED", {
      requestId: "request-1",
      causeCode: "KAF_AUTHORIZATION_EXPIRED",
      details: { reason: "revoked", count: 1, denied: true, extra: null },
      internalCause: internal,
    });
    expect(error.cause).toBe(internal);
    expect(Object.keys(error)).not.toContain("cause");
    expect(KafPublicErrorSchema.parse(error.toJSON())).toMatchObject({
      code: "KAF_POLICY_DENIED",
      requestId: "request-1",
      causeCode: "KAF_AUTHORIZATION_EXPIRED",
    });
    expect(new KafError("KAF_STORAGE_NOT_FOUND").toJSON()).not.toHaveProperty("details");
    expect(parseWire(z.object({ id: z.string() }), { id: "ok" })).toEqual({ id: "ok" });
    expect(() => parseWire(z.object({ id: z.string() }), { id: 1 })).toThrow(KafError);
  });

  it("covers authority primitive rejection and command entropy/window edge cases", () => {
    const issuer = createAuthorityIssuer("issuer");
    expect(issuer.verify(null, new Date())).toEqual({ valid: false, reason: "not_issued" });
    expect(issuer.verify("wire", new Date())).toEqual({ valid: false, reason: "not_issued" });
    expect(() =>
      createCommandId({ now: () => new Date(0), randomBytes: () => new Uint8Array(16) }),
    ).toThrow(RangeError);
    expect(() =>
      createCommandId({
        now: () => new Date("2026-08-03T10:00:00Z"),
        randomBytes: () => new Uint8Array(15),
      }),
    ).toThrow(RangeError);
    const commandId = createCommandId({
      now: () => new Date("2026-08-03T10:00:00Z"),
      randomBytes: () => new Uint8Array(16),
    });
    expect(
      validateCommandIdWindow(commandId, {
        now: new Date("2026-08-03T10:00:01Z"),
        maximumFutureSkewMs: 1_000,
        idempotencyHorizonMs: 60_000,
      }),
    ).toMatchObject({ valid: true });
  });

  it("keeps resolved credentials non-serializable and exercises every deny-all port", async () => {
    expect(() => ResolvedModelCredential.fromAdapter("")).toThrow(TypeError);
    expect(() => ResolvedToolCredential.fromAdapter("")).toThrow(TypeError);
    const model = ResolvedModelCredential.fromAdapter("model-canary");
    const tool = ResolvedToolCredential.fromAdapter("tool-canary");
    expect(model.use((value) => value.length)).toBe(12);
    expect(tool.use((value) => value.length)).toBe(11);
    expect(() => model.toJSON()).toThrow("KAF_CREDENTIAL_SERIALIZATION_FORBIDDEN");
    expect(() => tool.toJSON()).toThrow("KAF_CREDENTIAL_SERIALIZATION_FORBIDDEN");
    await expect(DenyAllModelCredentialIssuer.issue({} as never)).rejects.toBeInstanceOf(
      ModelCredentialDeniedError,
    );
    await expect(DenyAllModelCredentialResolver.resolve({} as never)).rejects.toBeInstanceOf(
      ModelCredentialDeniedError,
    );
    await expect(DenyAllToolCredentialIssuer.issue({} as never)).rejects.toBeInstanceOf(
      ToolCredentialDeniedError,
    );
    await expect(DenyAllSecretRefStore.putImmutable({} as never)).rejects.toBeInstanceOf(
      ToolCredentialDeniedError,
    );
    await expect(DenyAllSecretRefStore.get("tenant", "ref")).rejects.toBeInstanceOf(
      ToolCredentialDeniedError,
    );
    await expect(DenyAllSecretRefStore.revoke("tenant", "ref", "now")).rejects.toBeInstanceOf(
      ToolCredentialDeniedError,
    );
    await expect(DenyAllSecretResolver.resolve({} as never, {} as never)).rejects.toBeInstanceOf(
      ToolCredentialDeniedError,
    );
  });

  it("rejects an adapter registration without both bound model profiles", () => {
    expect(() =>
      defineModelAdapterRegistration({
        id: "adapter",
        implementationVersion: "1.0.0",
        credentialSlot: "provider.key",
        endpointOrigin: "https://example.com",
        endpointNormalizerVersion: "whatwg-origin@1",
        adapterArtifact: {
          packageName: "adapter",
          exportName: "create",
          packageVersion: "1.0.0",
          artifactDigest: `sha256:${"0".repeat(64)}`,
        },
        providerArtifact: {
          packageName: "provider",
          exportName: "model",
          packageVersion: "1.0.0",
          artifactDigest: `sha256:${"1".repeat(64)}`,
        },
        executorIdentity: {},
        egressEnforcementIdentity: {},
        conservativeEstimatorIdentity: {},
        providerOutputCapIdentity: {},
        streamCounterIdentity: {},
        usageTrustIdentity: {},
        capabilityContract: {},
      }),
    ).toThrow(/profile digests/u);
  });

  it("exercises schema parsing helpers and every registration registry factory", () => {
    const schema = defineSchema({
      id: "coverage.schema",
      semanticRevision: "1",
      schema: z.object({ value: z.string() }),
    });
    expect(schema.safeParse({ value: "ok" }).success).toBe(true);
    expect(parseWithSchema(schema, { value: "ok" })).toEqual({ value: "ok" });

    const tool = defineToolRegistration({
      id: "tool",
      implementationVersion: "1.0.0",
      inputSchemaIdentityDigest: schema.identity.schemaIdentityDigest,
      outputSchemaIdentityDigest: schema.identity.schemaIdentityDigest,
      securityMetadata: {},
      effectStrategyIdentity: {},
      executorIdentity: {},
      identifierNormalizerVersion: "1",
      resourceNormalizerVersion: "1",
      urlNormalizerVersion: "1",
    });
    const verifier = defineVerifierRegistration({
      id: "verifier",
      implementationVersion: "1.0.0",
      inputSchemaIdentityDigest: schema.identity.schemaIdentityDigest,
      outputSchemaIdentityDigest: schema.identity.schemaIdentityDigest,
      rubric: {},
      rules: {},
      executorIdentity: {},
    });
    const toolRegistry = createToolRegistrationRegistry();
    const verifierRegistry = createVerifierRegistrationRegistry();
    expect(toolRegistry.register(tool)).toBe(tool);
    expect(verifierRegistry.register(verifier)).toBe(verifier);
    expect(toolRegistry.resolve("tool", "missing")).toBeUndefined();
  });

  it("covers model profile pricing and model reservation binding refinements", () => {
    const baseProfile = {
      schemaVersion: "1",
      profileFormat: "pactmark.model-resource-profile@1",
      id: "resource",
      implementationVersion: "1.0.0",
      maxInputBytesPerCall: 10,
      maxInputTokensPerCall: 10,
      maxOutputTokensPerCall: 10,
      maxStreamedOutputBytesPerCall: 10,
      maxStreamEventsPerCall: 10,
      maxToolResultToContextBytes: 10,
      maxContextSnapshotBytes: 10,
      maxRunModelInputBytes: 10,
      maxRunModelInputTokens: 10,
      maxRunModelOutputBytes: 10,
      maxRunModelOutputTokens: 10,
      maxRunToolResultToContextBytes: 10,
      estimator: "estimator",
      providerOutputCap: "enforced",
      streamCounter: "counter",
      usageTrustPolicy: "local-floor",
      modelResourceProfileDigest: `sha256:${"2".repeat(64)}`,
    } as const;
    expect(
      ModelResourceProfileSchema.safeParse({ ...baseProfile, pricingIdentity: "price" }).success,
    ).toBe(false);
    expect(
      ModelResourceProfileSchema.safeParse({
        ...baseProfile,
        pricingIdentity: "price",
        priceTableDigest: `sha256:${"3".repeat(64)}`,
        priceCurrency: "USD",
        priceTableExpiresAt: "2026-08-04T10:00:00Z",
      }).success,
    ).toBe(true);
    const reservation = {
      schemaVersion: "1",
      reservationId: "reservation",
      tenantId: "tenant",
      runId: "run",
      stepId: "step",
      attempt: 1,
      workOrderBindingDigest: `sha256:${"0".repeat(64)}`,
      agentDefinitionDigest: `sha256:${"0".repeat(64)}`,
      modelSecurityProfileDigest: `sha256:${"0".repeat(64)}`,
      modelResourceProfileDigest: `sha256:${"0".repeat(64)}`,
      modelAdapterRegistrationDigest: `sha256:${"0".repeat(64)}`,
      inputBytes: 1,
      inputTokenUpperBound: 1,
      outputTokenMaximum: 1,
      status: "accepted",
      expiresAt: "2026-08-04T10:00:00Z",
      createdAt: "2026-08-03T10:00:00Z",
    } as const;
    expect(ModelCallReservationSchema.safeParse({ ...reservation, currency: "USD" }).success).toBe(
      false,
    );
    expect(
      ModelCallReservationSchema.safeParse({
        ...reservation,
        maximumCallCostMinor: 1,
        currency: "USD",
      }).success,
    ).toBe(true);
    const binding = {
      schemaVersion: "1",
      tenantId: "tenant",
      authoritySubject: "user",
      workOrderBindingDigest: reservation.workOrderBindingDigest,
      agentDefinitionDigest: reservation.agentDefinitionDigest,
      modelSecurityProfileDigest: reservation.modelSecurityProfileDigest,
      modelResourceProfileDigest: reservation.modelResourceProfileDigest,
      modelAdapterRegistrationDigest: reservation.modelAdapterRegistrationDigest,
      reservationId: reservation.reservationId,
      providerEndpointOrigin: "https://example.com",
      purpose: "service_delivery",
      permittedDataClasses: ["public"],
      credentialSlot: "provider.key",
    } as const;
    for (const field of [
      "tenantId",
      "workOrderBindingDigest",
      "agentDefinitionDigest",
      "modelSecurityProfileDigest",
      "modelResourceProfileDigest",
      "modelAdapterRegistrationDigest",
    ] as const) {
      expect(
        ModelCredentialIssueRequestSchema.safeParse({
          schemaVersion: "1",
          binding: {
            ...binding,
            [field]: field === "tenantId" ? "other" : `sha256:${"4".repeat(64)}`,
          },
          reservation,
          expiresAt: reservation.expiresAt,
        }).success,
      ).toBe(false);
    }
    expect(
      ModelCredentialIssueRequestSchema.safeParse({
        schemaVersion: "1",
        binding: { ...binding, reservationId: "other" },
        reservation: { ...reservation, status: "dispatched" },
        expiresAt: reservation.expiresAt,
      }).success,
    ).toBe(false);
  });

  it("covers every pattern promotion evidence branch", () => {
    const base = PatternManifestSchema.parse({
      schemaVersion: "1",
      patternId: "pattern",
      version: "1.0.0",
      patternDigest: `sha256:${"0".repeat(64)}`,
      title: "Pattern",
      description: "Description",
      maturity: "candidate",
      scaleUnit: { roleFamily: "research", workflowId: "brief", riskClass: "low" },
      assetRefs: [
        {
          kind: "agent",
          id: "agent",
          version: "1.0.0",
          digest: `sha256:${"0".repeat(64)}`,
        },
      ],
      evidenceRecordDigests: [],
      independentObservationCount: 0,
      supportedClaims: ["claim"],
      doesNotProve: ["impact"],
      createdAt: "2026-08-03T10:00:00Z",
      updatedAt: "2026-08-03T10:00:00Z",
    });
    expect(() => {
      assertPatternPromotion(base, "locally_verified");
    }).not.toThrow();
    expect(() => {
      assertPatternPromotion(base, "proven");
    }).toThrow(KafError);
    const repeated = {
      ...base,
      maturity: "repeated" as const,
      independentObservationCount: 2,
    };
    expect(() => {
      assertPatternPromotion(repeated, "proven");
    }).toThrow(KafError);
    expect(() => {
      assertPatternPromotion(
        {
          ...repeated,
          baseline: {
            metric: "quality",
            description: "Declared baseline",
            baselineDigest: `sha256:${"1".repeat(64)}`,
            advantageEvidenceDigest: `sha256:${"2".repeat(64)}`,
            measuredAdvantage: 1,
            unit: "quality-point",
          },
        },
        "proven",
      );
    }).not.toThrow();
  });
});

describe("canonical JSON edge matrix", () => {
  it("accepts every JSON primitive/container form and rejects exotic object mechanics", () => {
    expect(parseJsonStrict(' \t\r\n{"empty":[],"object":{},"n":-1.25e+2}')).toMatchObject({
      n: -125,
    });
    expect(parseJsonStrict('"escaped\\n\\t\\u20ac"')).toBe("escaped\n\t€");
    expect(parseJsonStrict("0")).toBe(0);
    expect(parseJsonStrict("false")).toBe(false);
    expect(parseJsonStrict("null")).toBeNull();
    expect(canonicalJsonStringify(Object.create(null) as object)).toBe("{}");

    const symbolKeyed = { value: 1, [Symbol("hidden")]: 2 };
    const accessor = Object.defineProperty({}, "secret", { enumerable: true, get: () => "x" });
    const nonEnumerable = Object.defineProperty({ visible: true }, "hidden", {
      enumerable: false,
      value: "x",
    });
    expect(canonicalJsonStringify(nonEnumerable)).toBe('{"visible":true}');
    for (const value of [symbolKeyed, accessor, new Map()]) {
      expect(() => canonicalJsonStringify(value)).toThrow(CanonicalJsonError);
    }
  });

  it("rejects malformed JSON at each parser boundary", () => {
    const malformed = [
      "",
      "truth",
      "nul",
      "01",
      "1.",
      "1e",
      "[",
      "[1",
      "[1 2]",
      "[,1]",
      "{",
      "{1:2}",
      '{"a" 1}',
      '{"a":1',
      '{"a":1 "b":2}',
      '"unterminated',
      '"bad\ncontrol"',
      '"\\uZZZZ"',
      "true false",
      "1e999",
    ];
    for (const source of malformed) {
      expect(() => parseJsonStrict(source)).toThrow(CanonicalJsonError);
    }
  });

  it("matches Web Crypto SHA-256 across padding and multi-block boundaries", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 1_024]) {
      const input = new Uint8Array(length).map((_, index) => index % 251);
      const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
      expect(sha256(input)).toEqual(expected);
    }
  });
});
