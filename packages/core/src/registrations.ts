import { z } from "zod";

import type { ModelResourceProfileSchema, ModelSecurityProfileSchema } from "./model.js";
import {
  DigestSchema,
  JsonValueSchema,
  digestCanonicalJson,
  type Digest,
} from "./serialization.js";

const IdSchema = z.string().min(1).max(250);
const VersionSchema = z.string().min(1).max(100);
const RegistrationBaseShape = {
  schemaVersion: z.literal("1"),
  id: IdSchema,
  implementationVersion: VersionSchema,
};

const ToolRegistrationMaterialSchema = z
  .object({
    ...RegistrationBaseShape,
    registrationFormat: z.literal("pactmark.tool-registration@1"),
    inputSchemaIdentityDigest: DigestSchema,
    outputSchemaIdentityDigest: DigestSchema,
    securityMetadata: JsonValueSchema,
    effectStrategyIdentity: JsonValueSchema,
    previewStrategyIdentity: JsonValueSchema.optional(),
    compensationStrategyIdentity: JsonValueSchema.optional(),
    executorIdentity: JsonValueSchema,
    identifierNormalizerVersion: VersionSchema,
    resourceNormalizerVersion: VersionSchema,
    urlNormalizerVersion: VersionSchema,
  })
  .strict();
export const ToolRegistrationSchema = ToolRegistrationMaterialSchema.extend({
  toolRegistrationDigest: DigestSchema,
}).strict();
export type ToolRegistration = z.infer<typeof ToolRegistrationSchema>;

const PolicyRegistrationMaterialSchema = z
  .object({
    ...RegistrationBaseShape,
    registrationFormat: z.literal("pactmark.policy-registration@1"),
    defaultDecision: z.literal("deny"),
    rules: JsonValueSchema,
    config: JsonValueSchema,
    schemaIdentityDigests: z.array(DigestSchema),
    reasonCodes: z.array(z.string().min(1)),
    executorIdentity: JsonValueSchema,
  })
  .strict();
export const PolicyRegistrationSchema = PolicyRegistrationMaterialSchema.extend({
  policyRegistrationDigest: DigestSchema,
}).strict();
export type PolicyRegistration = z.infer<typeof PolicyRegistrationSchema>;

const VerifierRegistrationMaterialSchema = z
  .object({
    ...RegistrationBaseShape,
    registrationFormat: z.literal("pactmark.verifier-registration@1"),
    inputSchemaIdentityDigest: DigestSchema,
    outputSchemaIdentityDigest: DigestSchema,
    rubric: JsonValueSchema,
    rules: JsonValueSchema,
    executorIdentity: JsonValueSchema,
  })
  .strict();
export const VerifierRegistrationSchema = VerifierRegistrationMaterialSchema.extend({
  verifierRegistrationDigest: DigestSchema,
}).strict();
export type VerifierRegistration = z.infer<typeof VerifierRegistrationSchema>;

const ReleasedArtifactIdentitySchema = z
  .object({
    packageName: z.string().min(1),
    exportName: z.string().min(1),
    packageVersion: z.string().min(1),
    artifactDigest: DigestSchema,
  })
  .strict();
export type ReleasedArtifactIdentity = z.infer<typeof ReleasedArtifactIdentitySchema>;

const ModelAdapterRegistrationMaterialSchema = z
  .object({
    ...RegistrationBaseShape,
    registrationFormat: z.literal("pactmark.model-adapter-registration@1"),
    modelSecurityProfileDigest: DigestSchema,
    modelResourceProfileDigest: DigestSchema,
    credentialSlot: z.string().min(1),
    endpointOrigin: z.url(),
    endpointNormalizerVersion: VersionSchema,
    adapterArtifact: ReleasedArtifactIdentitySchema,
    providerArtifact: ReleasedArtifactIdentitySchema,
    executorIdentity: JsonValueSchema,
    egressEnforcementIdentity: JsonValueSchema,
    conservativeEstimatorIdentity: JsonValueSchema,
    providerOutputCapIdentity: JsonValueSchema,
    streamCounterIdentity: JsonValueSchema,
    usageTrustIdentity: JsonValueSchema,
    pricingIdentity: JsonValueSchema.optional(),
    capabilityContract: JsonValueSchema,
  })
  .strict();
export const ModelAdapterRegistrationSchema = ModelAdapterRegistrationMaterialSchema.extend({
  modelAdapterRegistrationDigest: DigestSchema,
}).strict();
export type ModelAdapterRegistration = z.infer<typeof ModelAdapterRegistrationSchema>;

const StorageSecurityProfileMaterialSchema = z
  .object({
    schemaVersion: z.literal("1"),
    profileFormat: z.literal("pactmark.storage-security-profile@1"),
    id: IdSchema,
    implementationVersion: VersionSchema,
    allowedDataClasses: z
      .array(z.enum(["public", "internal", "confidential", "restricted"]))
      .min(1),
    allowedTenants: z.array(z.string().min(1)).min(1),
    allowedPurposes: z.array(z.string().min(1)).min(1),
    tenantIsolation: z.enum([
      "process",
      "database_constraint",
      "row_level_security",
      "external_service",
    ]),
    encryptionMode: z.enum(["none_ephemeral", "application_protected", "external_managed"]),
    transportSecurity: z.enum(["memory", "verify_full", "external_managed"]),
    processingRegion: z.string().min(1),
    retentionSupport: z.boolean(),
    deletionSupport: z.boolean(),
    backupResponsibility: z.string().min(1),
  })
  .strict();
export const StorageSecurityProfileSchema = StorageSecurityProfileMaterialSchema.extend({
  storageSecurityProfileDigest: DigestSchema,
}).strict();
export type StorageSecurityProfile = z.infer<typeof StorageSecurityProfileSchema>;

type MaterialInput<S extends z.ZodObject<z.ZodRawShape>> = Omit<
  z.input<S>,
  "schemaVersion" | "registrationFormat"
>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function materialize<M extends z.ZodObject<z.ZodRawShape>, R extends z.ZodType>(
  materialSchema: M,
  resultSchema: R,
  digestField: string,
  format: string,
  input: MaterialInput<M>,
): z.output<R> {
  const material = materialSchema.parse({
    schemaVersion: "1",
    registrationFormat: format,
    ...input,
  });
  return deepFreeze(
    resultSchema.parse({ ...material, [digestField]: digestCanonicalJson(material) }),
  );
}

export function defineToolRegistration(
  input: MaterialInput<typeof ToolRegistrationMaterialSchema>,
): ToolRegistration {
  return materialize(
    ToolRegistrationMaterialSchema,
    ToolRegistrationSchema,
    "toolRegistrationDigest",
    "pactmark.tool-registration@1",
    input,
  );
}

export function definePolicyRegistration(
  input: MaterialInput<typeof PolicyRegistrationMaterialSchema>,
): PolicyRegistration {
  return materialize(
    PolicyRegistrationMaterialSchema,
    PolicyRegistrationSchema,
    "policyRegistrationDigest",
    "pactmark.policy-registration@1",
    input,
  );
}

export function defineVerifierRegistration(
  input: MaterialInput<typeof VerifierRegistrationMaterialSchema>,
): VerifierRegistration {
  return materialize(
    VerifierRegistrationMaterialSchema,
    VerifierRegistrationSchema,
    "verifierRegistrationDigest",
    "pactmark.verifier-registration@1",
    input,
  );
}

export function defineModelAdapterRegistration(
  input: Omit<
    MaterialInput<typeof ModelAdapterRegistrationMaterialSchema>,
    "modelSecurityProfileDigest" | "modelResourceProfileDigest"
  > & {
    readonly modelSecurityProfileDigest?: Digest;
    readonly modelResourceProfileDigest?: Digest;
    readonly securityProfile?: z.infer<typeof ModelSecurityProfileSchema>;
    readonly resourceProfile?: z.infer<typeof ModelResourceProfileSchema>;
  },
): ModelAdapterRegistration {
  const { securityProfile, resourceProfile, ...materialInput } = input;
  const modelSecurityProfileDigest =
    materialInput.modelSecurityProfileDigest ?? securityProfile?.modelSecurityProfileDigest;
  const modelResourceProfileDigest =
    materialInput.modelResourceProfileDigest ?? resourceProfile?.modelResourceProfileDigest;
  if (modelSecurityProfileDigest === undefined || modelResourceProfileDigest === undefined) {
    throw new TypeError("Model adapter registration requires both model profile digests");
  }
  const withProfileDigests = {
    ...materialInput,
    modelSecurityProfileDigest,
    modelResourceProfileDigest,
  };
  return materialize(
    ModelAdapterRegistrationMaterialSchema,
    ModelAdapterRegistrationSchema,
    "modelAdapterRegistrationDigest",
    "pactmark.model-adapter-registration@1",
    withProfileDigests,
  );
}

export function defineStorageSecurityProfile(
  input: Omit<
    z.input<typeof StorageSecurityProfileMaterialSchema>,
    "schemaVersion" | "profileFormat"
  >,
): StorageSecurityProfile {
  const material = StorageSecurityProfileMaterialSchema.parse({
    schemaVersion: "1",
    profileFormat: "pactmark.storage-security-profile@1",
    ...input,
    allowedDataClasses: [...new Set(input.allowedDataClasses)].sort(),
    allowedTenants: [...new Set(input.allowedTenants)].sort(),
    allowedPurposes: [...new Set(input.allowedPurposes)].sort(),
  });
  return deepFreeze(
    StorageSecurityProfileSchema.parse({
      ...material,
      storageSecurityProfileDigest: digestCanonicalJson(material),
    }),
  );
}

export class RegistrationDriftError extends Error {
  readonly code = "KAF_REGISTRATION_SAME_VERSION_DRIFT" as const;

  constructor(
    readonly registrationId: string,
    readonly implementationVersion: string,
  ) {
    super(
      `Registration ${registrationId}@${implementationVersion} differs from the immutable registered digest`,
    );
    this.name = "RegistrationDriftError";
  }
}

type RegistrationRecord = Readonly<{
  id: string;
  implementationVersion: string;
}>;

/** In-memory identity registry. Adapter registries can enforce the same invariant durably. */
export class ImmutableRegistrationRegistry<T extends RegistrationRecord> {
  readonly #entries = new Map<string, T>();

  constructor(private readonly digestOf: (registration: T) => Digest) {}

  register(registration: T): T {
    const key = `${registration.id}\u0000${registration.implementationVersion}`;
    const existing = this.#entries.get(key);
    if (existing && this.digestOf(existing) !== this.digestOf(registration)) {
      throw new RegistrationDriftError(registration.id, registration.implementationVersion);
    }
    if (existing) return existing;
    const frozen = deepFreeze(registration);
    this.#entries.set(key, frozen);
    return frozen;
  }

  resolve(id: string, implementationVersion: string): T | undefined {
    return this.#entries.get(`${id}\u0000${implementationVersion}`);
  }
}

export function createToolRegistrationRegistry(): ImmutableRegistrationRegistry<ToolRegistration> {
  return new ImmutableRegistrationRegistry((registration) => registration.toolRegistrationDigest);
}

export function createPolicyRegistrationRegistry(): ImmutableRegistrationRegistry<PolicyRegistration> {
  return new ImmutableRegistrationRegistry((registration) => registration.policyRegistrationDigest);
}

export function createVerifierRegistrationRegistry(): ImmutableRegistrationRegistry<VerifierRegistration> {
  return new ImmutableRegistrationRegistry(
    (registration) => registration.verifierRegistrationDigest,
  );
}

export function createModelAdapterRegistrationRegistry(): ImmutableRegistrationRegistry<ModelAdapterRegistration> {
  return new ImmutableRegistrationRegistry(
    (registration) => registration.modelAdapterRegistrationDigest,
  );
}
