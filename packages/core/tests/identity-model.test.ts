import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  CanonicalJsonError,
  DigestSchema,
  canonicalJsonStringify,
  digestBytes,
  digestCanonicalJson,
  parseJsonStrict,
  sha256,
} from "../src/serialization.js";
import {
  SchemaIdentityError,
  defineRegisteredSchemaSemantic,
  defineSchema,
  schemaIdentityDigest,
} from "../src/schema-identity.js";
import {
  ImmutableRegistrationRegistry,
  RegistrationDriftError,
  createModelAdapterRegistrationRegistry,
  createPolicyRegistrationRegistry,
  defineModelAdapterRegistration,
  definePolicyRegistration,
  defineStorageSecurityProfile,
  defineToolRegistration,
  defineVerifierRegistration,
} from "../src/registrations.js";
import {
  ModelCallReservationSchema,
  ModelResourceProfileSchema,
  ModelSecurityProfileSchema,
  defineModelResourceProfile,
  defineModelSecurityProfile,
} from "../src/model.js";
import {
  ModelCredentialIssueRequestSchema,
  ModelCredentialRefSchema,
  ResolvedModelCredential,
} from "../src/model-credential.js";
import { ResolvedToolCredential, SecretRefSchema } from "../src/tool-credential.js";

const D1 = digestCanonicalJson("one");
const D2 = digestCanonicalJson("two");
const D3 = digestCanonicalJson("three");

describe("canonical JSON and digests", () => {
  it("matches RFC 8785 canonical ordering and ECMAScript number serialization", () => {
    const source = {
      numbers: [333333333.3333333, 1e30, 4.5, 2e-3, 1e-27],
      string: '€$\u000f\nA\'B"\\"/',
      literals: [null, true, false],
    };
    expect(canonicalJsonStringify(source)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\"/"}',
    );
    expect(canonicalJsonStringify({ b: 1, a: { z: false, y: true } })).toBe(
      '{"a":{"y":true,"z":false},"b":1}',
    );
    expect(canonicalJsonStringify({ negativeZero: -0 })).toBe('{"negativeZero":0}');
  });

  it("matches the SHA-256 known vector and Web Crypto", async () => {
    const bytes = new TextEncoder().encode("abc");
    expect(digestBytes(bytes)).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const webCrypto = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    expect(sha256(bytes)).toEqual(webCrypto);
    expect(DigestSchema.safeParse("SHA256:" + "0".repeat(64)).success).toBe(false);
  });

  it("rejects every non-JSON or ambiguous input category", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = Array<unknown>(2);
    sparse[1] = 1;
    const cases: readonly [unknown, string][] = [
      [Number.NaN, "KAF_SERIALIZATION_NON_I_JSON_NUMBER"],
      [Infinity, "KAF_SERIALIZATION_NON_I_JSON_NUMBER"],
      [Number.MAX_SAFE_INTEGER + 1, "KAF_SERIALIZATION_NON_I_JSON_NUMBER"],
      [undefined, "KAF_SERIALIZATION_UNSUPPORTED_VALUE"],
      [1n, "KAF_SERIALIZATION_UNSUPPORTED_VALUE"],
      [Symbol("x"), "KAF_SERIALIZATION_UNSUPPORTED_VALUE"],
      [() => undefined, "KAF_SERIALIZATION_UNSUPPORTED_VALUE"],
      [new Date(), "KAF_SERIALIZATION_UNSUPPORTED_VALUE"],
      [cyclic, "KAF_SERIALIZATION_CYCLIC_VALUE"],
      [sparse, "KAF_SERIALIZATION_UNSUPPORTED_VALUE"],
      ["\ud800", "KAF_SERIALIZATION_INVALID_UNICODE"],
      ["\udc00", "KAF_SERIALIZATION_INVALID_UNICODE"],
    ];
    for (const [input, code] of cases) {
      try {
        canonicalJsonStringify(input);
        throw new Error("Expected canonicalization failure");
      } catch (error) {
        expect(error).toBeInstanceOf(CanonicalJsonError);
        expect((error as CanonicalJsonError).code).toBe(code);
      }
    }
    const withGetter = Object.defineProperty({}, "secret", { enumerable: true, get: () => "x" });
    expect(() => canonicalJsonStringify(withGetter)).toThrow(CanonicalJsonError);
  });

  it("parses strict JSON and rejects duplicate keys before object materialization", () => {
    expect(parseJsonStrict('{"z":1,"a":[true,null]}')).toEqual({ z: 1, a: [true, null] });
    expect(() => parseJsonStrict('{"a":1,"a":2}')).toThrow(
      expect.objectContaining({ code: "KAF_SERIALIZATION_DUPLICATE_KEY" }),
    );
    expect(() => parseJsonStrict('{"n":9007199254740992}')).toThrow(
      expect.objectContaining({ code: "KAF_SERIALIZATION_NON_I_JSON_NUMBER" }),
    );
    expect(() => parseJsonStrict('{"x":"\\ud800"}')).toThrow(
      expect.objectContaining({ code: "KAF_SERIALIZATION_INVALID_UNICODE" }),
    );
    expect(() => parseJsonStrict("[1,]")).toThrow(
      expect.objectContaining({ code: "KAF_SERIALIZATION_INVALID_JSON" }),
    );
  });

  it("keeps strict parsing symmetric with canonical number serialization", () => {
    const canonical = canonicalJsonStringify({ large: 1e30, threshold: 1e21 });
    const parsed = parseJsonStrict(canonical);
    expect(parsed).toEqual({ large: 1e30, threshold: 1e21 });
    expect(canonicalJsonStringify(parsed)).toBe(canonical);
    expect(() => parseJsonStrict('{"n":9007199254740992e0}')).toThrow(
      expect.objectContaining({ code: "KAF_SERIALIZATION_NON_I_JSON_NUMBER" }),
    );
    expect(parseJsonStrict('{"n":1000000000000000000000}')).toEqual({ n: 1e21 });
    for (const roundedAlias of [
      "999999999999999999999",
      "1000000000000000000001",
      "999999999999999999999.1",
    ]) {
      expect(() => parseJsonStrict(`{"n":${roundedAlias}}`)).toThrow(
        expect.objectContaining({ code: "KAF_SERIALIZATION_NON_I_JSON_NUMBER" }),
      );
    }
  });

  it("normalizes long decimal coefficients in linear time without accepting rounded aliases", () => {
    const zeros = "0".repeat(100_000);

    expect(parseJsonStrict(`1.${zeros}`)).toBe(1);
    expect(() => parseJsonStrict(`1.${zeros}1`)).toThrow(
      expect.objectContaining({ code: "KAF_SERIALIZATION_NON_I_JSON_NUMBER" }),
    );
  });
});

describe("SchemaIdentity", () => {
  it("preserves input/output inference and materializes a deterministic identity", () => {
    const schema = defineSchema({
      id: "example.input",
      semanticRevision: "1",
      schema: z.object({ name: z.string().min(1), count: z.number().int().optional() }),
    });
    expectTypeOf((input: unknown) => schema.parse(input)).returns.toEqualTypeOf<{
      name: string;
      count?: number;
    }>();
    expect(schema.parse({ name: "Pactmark" })).toEqual({ name: "Pactmark" });
    expect(schema.identity.canonicalJsonSchemaDigest).toMatch(/^sha256:/);
    expect(schemaIdentityDigest(schema.identity)).toBe(schema.identity.schemaIdentityDigest);
    expect(Object.isFrozen(schema.identity)).toBe(true);

    const repeated = defineSchema({
      id: "example.input",
      semanticRevision: "1",
      schema: z.object({ name: z.string().min(1), count: z.number().int().optional() }),
    });
    expect(repeated.identity).toEqual(schema.identity);
  });

  it("changes identity for shape, semantic revision, and registered semantic implementation", () => {
    const plain = defineSchema({ id: "shape", semanticRevision: "1", schema: z.string() });
    const revised = defineSchema({ id: "shape", semanticRevision: "2", schema: z.string() });
    const shaped = defineSchema({ id: "shape", semanticRevision: "1", schema: z.string().min(1) });
    expect(
      new Set([
        plain.identity.schemaIdentityDigest,
        revised.identity.schemaIdentityDigest,
        shaped.identity.schemaIdentityDigest,
      ]).size,
    ).toBe(3);

    const semantic = (artifact: typeof D1) =>
      defineRegisteredSchemaSemantic({
        kind: "check",
        id: "example.must-be-a@1",
        implementationVersion: artifact === D1 ? "1.0.0" : "1.0.1",
        implementationArtifactDigest: artifact,
      });
    const first = defineSchema({
      id: "refined",
      semanticRevision: "1",
      schema: z.string().refine((value) => value === "a"),
      registeredSemantics: [semantic(D1)],
    });
    const second = defineSchema({
      id: "refined",
      semanticRevision: "1",
      schema: z.string().refine((value) => value === "a"),
      registeredSemantics: [semantic(D2)],
    });
    expect(first.identity.schemaIdentityDigest).not.toBe(second.identity.schemaIdentityDigest);
  });

  it("rejects anonymous semantics, excess identities, and unrepresentable schemas", () => {
    expect(() =>
      defineSchema({ id: "anonymous", semanticRevision: "1", schema: z.string().refine(Boolean) }),
    ).toThrow(SchemaIdentityError);
    const registered = defineRegisteredSchemaSemantic({
      kind: "check",
      id: "unused@1",
      implementationVersion: "1.0.0",
      implementationArtifactDigest: D1,
    });
    expect(() =>
      defineSchema({
        id: "excess",
        semanticRevision: "1",
        schema: z.string(),
        registeredSemantics: [registered],
      }),
    ).toThrow(SchemaIdentityError);
    expect(() => defineSchema({ id: "date", semanticRevision: "1", schema: z.date() })).toThrow(
      SchemaIdentityError,
    );
  });
});

const securityProfile = defineModelSecurityProfile({
  id: "provider.public@1",
  provider: "provider",
  model: "model-v1",
  endpointOrigin: "https://EXAMPLE.com:443",
  credentialSlot: "provider.api-key",
  allowedTenants: ["tenant-b", "tenant-a", "tenant-a"],
  allowedPurposes: ["service_delivery"],
  allowedDataClasses: ["public"],
  processingRegion: "provider_managed",
  retention: "host_contract_declared",
  logging: "host_contract_declared",
  training: "host_contract_declared",
  contractReference: "contract-2026-01",
});

const resourceProfile = defineModelResourceProfile({
  id: "provider.resources@1",
  implementationVersion: "1.0.0",
  maxInputBytesPerCall: 1000,
  maxInputTokensPerCall: 500,
  maxOutputTokensPerCall: 100,
  maxStreamedOutputBytesPerCall: 1000,
  maxStreamEventsPerCall: 100,
  maxToolResultToContextBytes: 1000,
  maxContextSnapshotBytes: 2000,
  maxRunModelInputBytes: 5000,
  maxRunModelInputTokens: 2500,
  maxRunModelOutputBytes: 5000,
  maxRunModelOutputTokens: 500,
  maxRunToolResultToContextBytes: 5000,
  estimator: "provider.conservative@1",
  providerOutputCap: "enforced",
});

describe("model profiles and immutable registrations", () => {
  it("normalizes model origins, sets finite defaults, and validates profile digests", () => {
    expect(securityProfile.endpointOrigin).toBe("https://example.com");
    expect(securityProfile.allowedTenants).toEqual(["tenant-a", "tenant-b"]);
    expect(ModelSecurityProfileSchema.parse(securityProfile)).toBeTruthy();
    expect(ModelResourceProfileSchema.parse(resourceProfile)).toBeTruthy();
    expect(resourceProfile.streamCounter).toBe("pactmark.utf8-and-event-counter@1");
    expect(() =>
      defineModelSecurityProfile({
        ...securityProfile,
        endpointOrigin: "https://example.com/path",
      }),
    ).toThrow();
    expect(() =>
      defineModelResourceProfile({ ...resourceProfile, maxInputBytesPerCall: Infinity }),
    ).toThrow();
  });

  it("digests complete tool/policy/verifier registrations", () => {
    const tool = defineToolRegistration({
      id: "example.read@1",
      implementationVersion: "1.0.0",
      inputSchemaIdentityDigest: D1,
      outputSchemaIdentityDigest: D2,
      securityMetadata: { riskClass: "R1", default: "deny" },
      effectStrategyIdentity: { kind: "read", implementationVersion: "1" },
      executorIdentity: { package: "executor", export: "execute", artifactDigest: D3 },
      identifierNormalizerVersion: "1",
      resourceNormalizerVersion: "1",
      urlNormalizerVersion: "1",
    });
    const policy = definePolicyRegistration({
      id: "example.policy",
      implementationVersion: "1.0.0",
      defaultDecision: "deny",
      rules: [{ riskClass: "R1", decision: "allow_with_grant" }],
      config: {},
      schemaIdentityDigests: [D1],
      reasonCodes: ["KAF_POLICY_ALLOWED_WITH_GRANT"],
      executorIdentity: { package: "policy", artifactDigest: D2 },
    });
    const verifier = defineVerifierRegistration({
      id: "example.verifier@1",
      implementationVersion: "1.0.0",
      inputSchemaIdentityDigest: D1,
      outputSchemaIdentityDigest: D2,
      rubric: { required: ["schema"] },
      rules: [],
      executorIdentity: { package: "verifier", artifactDigest: D3 },
    });
    expect(tool.toolRegistrationDigest).toMatch(/^sha256:/);
    expect(policy.policyRegistrationDigest).toMatch(/^sha256:/);
    expect(verifier.verifierRegistrationDigest).toMatch(/^sha256:/);
    expect(Object.isFrozen(tool)).toBe(true);
  });

  it("rejects same ID/version drift while making exact replay idempotent", () => {
    const base = {
      id: "policy",
      implementationVersion: "1.0.0",
      defaultDecision: "deny" as const,
      rules: [] as const,
      config: {},
      schemaIdentityDigests: [D1],
      reasonCodes: ["DENY"],
      executorIdentity: { artifactDigest: D1 },
    };
    const first = definePolicyRegistration(base);
    const changed = definePolicyRegistration({ ...base, rules: [{ decision: "allow" }] });
    const registry = createPolicyRegistrationRegistry();
    expect(registry.register(first)).toBe(first);
    expect(registry.register(first)).toBe(first);
    expect(() => registry.register(changed)).toThrow(RegistrationDriftError);
  });

  it("does not alias delimiter-bearing registration ID and version tuples", () => {
    const registry = new ImmutableRegistrationRegistry<{
      id: string;
      implementationVersion: string;
      digest: typeof D1;
    }>((registration) => registration.digest);
    const first = { id: "a\u0000b", implementationVersion: "c", digest: D1 };
    const second = { id: "a", implementationVersion: "b\u0000c", digest: D2 };
    expect(registry.register(first)).toEqual(first);
    expect(registry.register(second)).toEqual(second);
    expect(registry.resolve(first.id, first.implementationVersion)).toEqual(first);
    expect(registry.resolve(second.id, second.implementationVersion)).toEqual(second);
  });

  it("binds adapter registration to both model profiles and released artifacts", () => {
    const registration = defineModelAdapterRegistration({
      id: "provider.adapter@1",
      implementationVersion: "1.0.0",
      modelSecurityProfileDigest: securityProfile.modelSecurityProfileDigest,
      modelResourceProfileDigest: resourceProfile.modelResourceProfileDigest,
      credentialSlot: "provider.api-key",
      endpointOrigin: securityProfile.endpointOrigin,
      endpointNormalizerVersion: "whatwg-origin@1",
      adapterArtifact: {
        packageName: "@pactmark/provider",
        exportName: "adapter",
        packageVersion: "1.0.0",
        artifactDigest: D1,
      },
      providerArtifact: {
        packageName: "provider",
        exportName: "create",
        packageVersion: "2.0.0",
        artifactDigest: D2,
      },
      executorIdentity: { id: "executor@1" },
      egressEnforcementIdentity: { networkPolicy: "declared" },
      conservativeEstimatorIdentity: { id: resourceProfile.estimator },
      providerOutputCapIdentity: { id: "output-cap@1" },
      streamCounterIdentity: { id: resourceProfile.streamCounter },
      usageTrustIdentity: { id: resourceProfile.usageTrustPolicy },
      capabilityContract: { streaming: true, tools: true },
    });
    const registry = createModelAdapterRegistrationRegistry();
    expect(registry.register(registration)).toBe(registration);
    const changed = {
      ...registration,
      capabilityContract: { streaming: false },
      modelAdapterRegistrationDigest: D3,
    };
    expect(() => registry.register(changed)).toThrow(RegistrationDriftError);
  });

  it("materializes storage profiles without accepting highly restricted data", () => {
    const storage = defineStorageSecurityProfile({
      id: "memory@1",
      implementationVersion: "1.0.0",
      allowedDataClasses: ["internal", "public"],
      allowedTenants: ["local"],
      allowedPurposes: ["service_delivery"],
      tenantIsolation: "process",
      encryptionMode: "none_ephemeral",
      transportSecurity: "memory",
      processingRegion: "process_local",
      retentionSupport: true,
      deletionSupport: true,
      backupResponsibility: "host",
    });
    expect(storage.storageSecurityProfileDigest).toMatch(/^sha256:/);
  });
});

describe("credential boundaries", () => {
  const reservation = ModelCallReservationSchema.parse({
    schemaVersion: "1",
    reservationId: "reservation-1",
    tenantId: "tenant-a",
    runId: "run-1",
    stepId: "step-1",
    attempt: 1,
    workOrderBindingDigest: D1,
    agentDefinitionDigest: D2,
    modelSecurityProfileDigest: securityProfile.modelSecurityProfileDigest,
    modelResourceProfileDigest: resourceProfile.modelResourceProfileDigest,
    modelAdapterRegistrationDigest: D3,
    inputBytes: 10,
    inputTokenUpperBound: 5,
    outputTokenMaximum: 5,
    status: "accepted",
    expiresAt: "2026-08-03T11:00:00.000Z",
    createdAt: "2026-08-03T10:00:00.000Z",
  });
  const binding = {
    schemaVersion: "1" as const,
    tenantId: reservation.tenantId,
    authoritySubject: "user-1",
    workOrderBindingDigest: reservation.workOrderBindingDigest,
    agentDefinitionDigest: reservation.agentDefinitionDigest,
    modelSecurityProfileDigest: reservation.modelSecurityProfileDigest,
    modelResourceProfileDigest: reservation.modelResourceProfileDigest,
    modelAdapterRegistrationDigest: reservation.modelAdapterRegistrationDigest,
    reservationId: reservation.reservationId,
    providerEndpointOrigin: "https://example.com",
    purpose: "service_delivery",
    permittedDataClasses: ["public" as const],
    credentialSlot: "provider.api-key",
  };

  it("requires an accepted, exactly bound reservation before model credential issuance", () => {
    expect(
      ModelCredentialIssueRequestSchema.safeParse({
        schemaVersion: "1",
        binding,
        reservation,
        expiresAt: reservation.expiresAt,
      }).success,
    ).toBe(true);
    expect(
      ModelCredentialIssueRequestSchema.safeParse({
        schemaVersion: "1",
        binding: { ...binding, tenantId: "other" },
        reservation,
        expiresAt: reservation.expiresAt,
      }).success,
    ).toBe(false);
  });

  it("makes model and tool reference schemas disjoint and rejects secret-looking extra fields", () => {
    const modelRef = {
      schemaVersion: "1",
      credentialKind: "model",
      refId: "model-ref",
      issuerId: "issuer",
      ...binding,
      issuedAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
    };
    expect(ModelCredentialRefSchema.safeParse(modelRef).success).toBe(true);
    expect(SecretRefSchema.safeParse(modelRef).success).toBe(false);
    expect(ModelCredentialRefSchema.safeParse({ ...modelRef, secret: "canary" }).success).toBe(
      false,
    );

    const toolRef = {
      schemaVersion: "1",
      credentialKind: "tool",
      refId: "tool-ref",
      issuerId: "issuer",
      tenantId: "tenant-a",
      authoritySubject: "user-1",
      workOrderBindingDigest: D1,
      executionDefinitionKind: "agent",
      executionDefinitionDigest: D2,
      grantId: "grant-1",
      toolId: "example.read@1",
      toolVersion: "1",
      toolRegistrationDigest: D3,
      credentialSlot: "search.api-key",
      normalizedDestinationDigest: D1,
      purpose: "service_delivery",
      maximumUses: 1,
      issuedAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
    };
    expect(SecretRefSchema.safeParse(toolRef).success).toBe(true);
    expect(ModelCredentialRefSchema.safeParse(toolRef).success).toBe(false);
  });

  it("prevents resolved credential serialization and preserves port-specific wrappers", () => {
    const model = ResolvedModelCredential.fromAdapter("model-canary");
    const tool = ResolvedToolCredential.fromAdapter("tool-canary");
    expect(model.use((value) => value.length)).toBe(12);
    expect(tool.use((value) => value.length)).toBe(11);
    expect(() => JSON.stringify(model)).toThrow("KAF_CREDENTIAL_SERIALIZATION_FORBIDDEN");
    expect(() => JSON.stringify(tool)).toThrow("KAF_CREDENTIAL_SERIALIZATION_FORBIDDEN");
    expectTypeOf(model).not.toEqualTypeOf<ResolvedToolCredential>();
  });
});

void ImmutableRegistrationRegistry;
