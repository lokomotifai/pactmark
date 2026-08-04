import { z } from "zod";

import { DigestSchema, digestCanonicalJson } from "./serialization.js";

const IdentifierSchema = z.string().min(1).max(200);
const NonEmptyStringSchema = z.string().min(1).max(500);
const PositiveFiniteIntegerSchema = z.number().int().positive();

export const ModelDataClassSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
  "highly_restricted",
]);
export type ModelDataClass = z.infer<typeof ModelDataClassSchema>;

const ModelSecurityProfileMaterialSchema = z
  .object({
    schemaVersion: z.literal("1"),
    profileFormat: z.literal("pactmark.model-security-profile@1"),
    profileVersion: NonEmptyStringSchema,
    id: IdentifierSchema,
    provider: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    endpointOrigin: z.url(),
    endpointNormalizerVersion: z.literal("whatwg-origin@1"),
    credentialSlot: NonEmptyStringSchema,
    allowedTenants: z.array(NonEmptyStringSchema).min(1),
    allowedPurposes: z.array(NonEmptyStringSchema).min(1),
    allowedDataClasses: z.array(ModelDataClassSchema).min(1),
    processingRegion: NonEmptyStringSchema,
    retention: NonEmptyStringSchema,
    logging: NonEmptyStringSchema,
    training: NonEmptyStringSchema,
    contractReference: NonEmptyStringSchema,
  })
  .strict();

export const ModelSecurityProfileSchema = ModelSecurityProfileMaterialSchema.extend({
  modelSecurityProfileDigest: DigestSchema,
}).strict();
export type ModelSecurityProfile = z.infer<typeof ModelSecurityProfileSchema>;

export interface DefineModelSecurityProfileInput {
  readonly profileVersion?: string;
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly endpointOrigin: string;
  readonly credentialSlot: string;
  readonly allowedTenants: readonly string[];
  readonly allowedPurposes: readonly string[];
  readonly allowedDataClasses: readonly ModelDataClass[];
  readonly processingRegion: string;
  readonly retention: string;
  readonly logging: string;
  readonly training: string;
  readonly contractReference: string;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TypeError(
      "Model endpointOrigin must be an origin without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}

function freeze<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) Object.freeze(child);
  }
  return Object.freeze(value);
}

export function defineModelSecurityProfile(
  input: DefineModelSecurityProfileInput,
): ModelSecurityProfile {
  const material = ModelSecurityProfileMaterialSchema.parse({
    schemaVersion: "1",
    profileFormat: "pactmark.model-security-profile@1",
    profileVersion: input.profileVersion ?? "1",
    ...input,
    endpointOrigin: normalizeOrigin(input.endpointOrigin),
    endpointNormalizerVersion: "whatwg-origin@1",
    allowedTenants: [...new Set(input.allowedTenants)].sort(),
    allowedPurposes: [...new Set(input.allowedPurposes)].sort(),
    allowedDataClasses: [...new Set(input.allowedDataClasses)].sort(),
  });
  return freeze(
    ModelSecurityProfileSchema.parse({
      ...material,
      modelSecurityProfileDigest: digestCanonicalJson(material),
    }),
  );
}

const ModelResourceProfileMaterialSchema = z
  .object({
    schemaVersion: z.literal("1"),
    profileFormat: z.literal("pactmark.model-resource-profile@1"),
    id: IdentifierSchema,
    implementationVersion: NonEmptyStringSchema,
    maxInputBytesPerCall: PositiveFiniteIntegerSchema,
    maxInputTokensPerCall: PositiveFiniteIntegerSchema,
    maxOutputTokensPerCall: PositiveFiniteIntegerSchema,
    maxStreamedOutputBytesPerCall: PositiveFiniteIntegerSchema,
    maxStreamEventsPerCall: PositiveFiniteIntegerSchema,
    maxToolResultToContextBytes: PositiveFiniteIntegerSchema,
    maxContextSnapshotBytes: PositiveFiniteIntegerSchema,
    maxRunModelInputBytes: PositiveFiniteIntegerSchema,
    maxRunModelInputTokens: PositiveFiniteIntegerSchema,
    maxRunModelOutputBytes: PositiveFiniteIntegerSchema,
    maxRunModelOutputTokens: PositiveFiniteIntegerSchema,
    maxRunToolResultToContextBytes: PositiveFiniteIntegerSchema,
    estimator: NonEmptyStringSchema,
    providerOutputCap: z.literal("enforced"),
    streamCounter: NonEmptyStringSchema,
    usageTrustPolicy: NonEmptyStringSchema,
    pricingIdentity: NonEmptyStringSchema.optional(),
    priceTableDigest: DigestSchema.optional(),
    priceCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    priceTableExpiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const pricingFields = [
      value.pricingIdentity,
      value.priceTableDigest,
      value.priceCurrency,
      value.priceTableExpiresAt,
    ];
    const present = pricingFields.filter((field) => field !== undefined).length;
    if (present !== 0 && present !== pricingFields.length) {
      context.addIssue({ code: "custom", message: "Pricing fields must be supplied together" });
    }
  });

export const ModelResourceProfileSchema = ModelResourceProfileMaterialSchema.safeExtend({
  modelResourceProfileDigest: DigestSchema,
}).strict();
export type ModelResourceProfile = z.infer<typeof ModelResourceProfileSchema>;
export type DefineModelResourceProfileInput = Omit<
  z.input<typeof ModelResourceProfileMaterialSchema>,
  "schemaVersion" | "profileFormat" | "streamCounter" | "usageTrustPolicy"
> & {
  readonly streamCounter?: string;
  readonly usageTrustPolicy?: string;
};

export function defineModelResourceProfile(
  input: DefineModelResourceProfileInput,
): ModelResourceProfile {
  const material = ModelResourceProfileMaterialSchema.parse({
    schemaVersion: "1",
    profileFormat: "pactmark.model-resource-profile@1",
    streamCounter: "pactmark.utf8-and-event-counter@1",
    usageTrustPolicy: "pactmark.conservative-local-floor@1",
    ...input,
  });
  return freeze(
    ModelResourceProfileSchema.parse({
      ...material,
      modelResourceProfileDigest: digestCanonicalJson(material),
    }),
  );
}

export const AgentExecutionDefinitionRefSchema = z
  .object({
    kind: z.literal("agent"),
    id: IdentifierSchema,
    version: NonEmptyStringSchema,
    agentDefinitionDigest: DigestSchema,
  })
  .strict();
export type AgentExecutionDefinitionRef = z.infer<typeof AgentExecutionDefinitionRefSchema>;

export const ModelCallSettlementSchema = z
  .object({
    schemaVersion: z.literal("1"),
    inputBytes: PositiveFiniteIntegerSchema,
    inputTokenLowerBound: PositiveFiniteIntegerSchema,
    outputBytes: z.number().int().nonnegative(),
    outputTokenLowerBound: z.number().int().nonnegative(),
    chargedTokens: PositiveFiniteIntegerSchema,
    chargedIoBytes: PositiveFiniteIntegerSchema,
    chargedCostMinor: z.number().int().nonnegative().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    settledAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.chargedCostMinor === undefined) !== (value.currency === undefined)) {
      context.addIssue({ code: "custom", message: "settled cost and currency must match" });
    }
  });
export type ModelCallSettlement = z.infer<typeof ModelCallSettlementSchema>;

export const ModelCallReservationSchema = z
  .object({
    schemaVersion: z.literal("1"),
    reservationId: IdentifierSchema,
    tenantId: IdentifierSchema,
    runId: IdentifierSchema,
    stepId: IdentifierSchema,
    attempt: PositiveFiniteIntegerSchema,
    workOrderBindingDigest: DigestSchema,
    agentDefinitionDigest: DigestSchema,
    modelSecurityProfileDigest: DigestSchema,
    modelResourceProfileDigest: DigestSchema,
    modelAdapterRegistrationDigest: DigestSchema,
    inputBytes: PositiveFiniteIntegerSchema,
    inputTokenUpperBound: PositiveFiniteIntegerSchema,
    outputTokenMaximum: PositiveFiniteIntegerSchema,
    outputBytesMaximum: PositiveFiniteIntegerSchema.optional(),
    maximumCallCostMinor: z.number().int().nonnegative().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    status: z.enum(["accepted", "dispatched", "settled", "uncertain", "expired"]),
    expiresAt: z.iso.datetime({ offset: true }),
    createdAt: z.iso.datetime({ offset: true }),
    settlement: ModelCallSettlementSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.maximumCallCostMinor === undefined) !== (value.currency === undefined)) {
      context.addIssue({
        code: "custom",
        message: "maximumCallCostMinor and currency must be supplied together",
      });
    }
    if ((value.status === "settled") !== (value.settlement !== undefined)) {
      context.addIssue({ code: "custom", message: "settled reservation requires settlement" });
    }
  });
export type ModelCallReservation = z.infer<typeof ModelCallReservationSchema>;

export const ModelCallBindingSchema = z
  .object({
    schemaVersion: z.literal("1"),
    tenantId: IdentifierSchema,
    authoritySubject: IdentifierSchema,
    workOrderBindingDigest: DigestSchema,
    agentDefinitionDigest: DigestSchema,
    modelSecurityProfileDigest: DigestSchema,
    modelResourceProfileDigest: DigestSchema,
    modelAdapterRegistrationDigest: DigestSchema,
    reservationId: IdentifierSchema,
    providerEndpointOrigin: z.url(),
    purpose: NonEmptyStringSchema,
    permittedDataClasses: z.array(ModelDataClassSchema).min(1),
    credentialSlot: NonEmptyStringSchema,
  })
  .strict();
export type ModelCallBinding = z.infer<typeof ModelCallBindingSchema>;
