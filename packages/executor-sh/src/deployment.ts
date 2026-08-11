import { z } from "zod";

import { DigestSchema, digestCanonicalJson, type Digest } from "@pactmark/core";
import { ExecutorAdapterError } from "./errors.js";

export const EXECUTOR_SELF_HOST_VERSION = "1.5.40" as const;
export const EXECUTOR_SELF_HOST_SOURCE_REVISION =
  "b029643641832ef5f9b0d4ff263d96e1a5b2739c" as const;
export const EXECUTOR_SELF_HOST_IMAGE_INDEX_DIGEST =
  "sha256:3e9792043be7819361eada0c5c87ebfa66e996e15772f75a39aae76facd4cb88" as const;
export const EXECUTOR_SELF_HOST_IMAGE_REPOSITORY =
  "ghcr.io/usefulsoftwareco/executor-selfhost" as const;
export const EXECUTOR_SELF_HOST_IMAGE =
  `${EXECUTOR_SELF_HOST_IMAGE_REPOSITORY}@${EXECUTOR_SELF_HOST_IMAGE_INDEX_DIGEST}` as const;
export const EXECUTOR_SELF_HOST_MAX_RECEIPT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export const ExecutorSelfHostPlatformSchema = z.enum(["linux/amd64", "linux/arm64"]);
export type ExecutorSelfHostPlatform = z.infer<typeof ExecutorSelfHostPlatformSchema>;

const manifestDigests = Object.freeze({
  "linux/amd64": "sha256:2f6cc4e03470b1eca58f4cec08b99d3195fbffa07e4c626cf89cc328a74504d4",
  "linux/arm64": "sha256:603522956d12788f9b50badd83e339ff5ab75486b4c16e4f10f46b6d0b49ee5b",
} satisfies Readonly<Record<ExecutorSelfHostPlatform, Digest>>);

export function executorSelfHostManifestDigest(platform: ExecutorSelfHostPlatform): Digest {
  return manifestDigests[ExecutorSelfHostPlatformSchema.parse(platform)];
}

const IdentifierSchema = z.string().min(1).max(200);

const ExecutorSelfHostConformanceChecksSchema = z
  .object({
    imagePinMatched: z.literal(true),
    sourceRevisionMatched: z.literal(true),
    mainProcessNonRoot: z.literal(true),
    readOnlyRootFilesystem: z.literal(true),
    capabilitiesDropped: z.literal(true),
    noNewPrivileges: z.literal(true),
    resourceLimitsApplied: z.literal(true),
    dedicatedDataVolume: z.literal(true),
    restartPersistence: z.literal(true),
    backupRestore: z.literal(true),
    telemetryDisabled: z.literal(true),
    analyticsIdAbsent: z.literal(true),
    outboundNetworkDenied: z.literal(true),
    privateNetworkDenied: z.literal(true),
    stdioMcpDisabled: z.literal(true),
    bootstrapCompleted: z.literal(true),
    unauthenticatedMcpDenied: z.literal(true),
    apiKeyMcpAuthenticated: z.literal(true),
    oauthPkceAuthenticated: z.literal(true),
    crossTenantCredentialDenied: z.literal(true),
    credentialCanariesAbsent: z.literal(true),
    executeEnvelopeMatched: z.literal(true),
  })
  .strict();
export type ExecutorSelfHostConformanceChecks = z.infer<
  typeof ExecutorSelfHostConformanceChecksSchema
>;

const ExecutorSelfHostConformanceReceiptMaterialSchema = z
  .object({
    schemaVersion: z.literal("1"),
    receiptFormat: z.literal("pactmark.executor-sh-selfhost-conformance@1"),
    executorVersion: z.literal(EXECUTOR_SELF_HOST_VERSION),
    sourceRevision: z.literal(EXECUTOR_SELF_HOST_SOURCE_REVISION),
    imageIndexDigest: z.literal(EXECUTOR_SELF_HOST_IMAGE_INDEX_DIGEST),
    platform: ExecutorSelfHostPlatformSchema,
    imageManifestDigest: DigestSchema,
    containerRuntime: z.literal("docker"),
    containerRuntimeVersion: z.string().min(1).max(100),
    environmentDigest: DigestSchema,
    observedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    checks: ExecutorSelfHostConformanceChecksSchema,
  })
  .strict();

export const ExecutorSelfHostConformanceReceiptSchema =
  ExecutorSelfHostConformanceReceiptMaterialSchema.extend({
    executorSelfHostConformanceReceiptDigest: DigestSchema,
  }).strict();
export type ExecutorSelfHostConformanceReceipt = z.infer<
  typeof ExecutorSelfHostConformanceReceiptSchema
>;

export interface DefineExecutorSelfHostConformanceReceiptInput {
  readonly platform: ExecutorSelfHostPlatform;
  readonly containerRuntimeVersion: string;
  readonly environmentDigest: Digest;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly checks: ExecutorSelfHostConformanceChecks;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function validReceiptWindow(observedAt: string, expiresAt: string): boolean {
  const observed = Date.parse(observedAt);
  const expires = Date.parse(expiresAt);
  return (
    Number.isFinite(observed) &&
    Number.isFinite(expires) &&
    expires > observed &&
    expires - observed <= EXECUTOR_SELF_HOST_MAX_RECEIPT_AGE_MS
  );
}

export function defineExecutorSelfHostConformanceReceipt(
  input: DefineExecutorSelfHostConformanceReceiptInput,
): ExecutorSelfHostConformanceReceipt {
  const material = ExecutorSelfHostConformanceReceiptMaterialSchema.parse({
    schemaVersion: "1",
    receiptFormat: "pactmark.executor-sh-selfhost-conformance@1",
    executorVersion: EXECUTOR_SELF_HOST_VERSION,
    sourceRevision: EXECUTOR_SELF_HOST_SOURCE_REVISION,
    imageIndexDigest: EXECUTOR_SELF_HOST_IMAGE_INDEX_DIGEST,
    ...input,
    imageManifestDigest: executorSelfHostManifestDigest(input.platform),
    containerRuntime: "docker",
  });
  if (!validReceiptWindow(material.observedAt, material.expiresAt)) {
    throw new ExecutorAdapterError(
      "KAF_EXECUTOR_DEPLOYMENT_NOT_READY",
      "Executor conformance receipt has an invalid validity window",
    );
  }
  return deepFreeze(
    ExecutorSelfHostConformanceReceiptSchema.parse({
      ...material,
      executorSelfHostConformanceReceiptDigest: digestCanonicalJson(material),
    }),
  );
}

export function verifyExecutorSelfHostConformanceReceipt(
  input: ExecutorSelfHostConformanceReceipt,
  evaluatedAt: string,
): ExecutorSelfHostConformanceReceipt {
  let receipt: ExecutorSelfHostConformanceReceipt;
  try {
    receipt = ExecutorSelfHostConformanceReceiptSchema.parse(input);
  } catch {
    throw new ExecutorAdapterError(
      "KAF_EXECUTOR_DEPLOYMENT_NOT_READY",
      "Executor conformance receipt is malformed",
    );
  }
  const { executorSelfHostConformanceReceiptDigest: claimed, ...material } = receipt;
  const evaluated = Date.parse(evaluatedAt);
  const valid =
    digestCanonicalJson(material) === claimed &&
    receipt.imageManifestDigest === executorSelfHostManifestDigest(receipt.platform) &&
    validReceiptWindow(receipt.observedAt, receipt.expiresAt) &&
    Number.isFinite(evaluated) &&
    evaluated >= Date.parse(receipt.observedAt) &&
    evaluated < Date.parse(receipt.expiresAt);
  if (!valid) {
    throw new ExecutorAdapterError(
      "KAF_EXECUTOR_DEPLOYMENT_NOT_READY",
      "Executor conformance receipt is drifted, expired, or not yet valid",
    );
  }
  return deepFreeze(receipt);
}

const ExecutorDeploymentProfileMaterialSchema = z
  .object({
    schemaVersion: z.literal("1"),
    profileFormat: z.literal("pactmark.executor-sh-deployment@1"),
    runtimeProfile: z.literal("production"),
    tenantId: IdentifierSchema,
    executorOrigin: z.url(),
    opaqueConnectionRef: IdentifierSchema,
    connectionBindingDigest: DigestSchema,
    conformanceReceiptDigest: DigestSchema,
    platform: ExecutorSelfHostPlatformSchema,
    tenantIsolation: z.literal("instance_per_tenant"),
    telemetry: z.literal("disabled"),
    analyticsOptOut: z.literal("DO_NOT_TRACK"),
    localNetworkAccess: z.literal("disabled"),
    stdioMcp: z.literal("disabled"),
    tls: z.literal("system_trusted_https"),
    processUser: z.literal("65532:65532"),
    readOnlyRootFilesystem: z.literal(true),
    capabilitiesDropped: z.literal("ALL"),
    noNewPrivileges: z.literal(true),
    dataVolume: z.literal("dedicated_encrypted"),
    backupPolicyId: IdentifierSchema,
  })
  .strict();

export const ExecutorDeploymentProfileSchema = ExecutorDeploymentProfileMaterialSchema.extend({
  executorDeploymentProfileDigest: DigestSchema,
}).strict();
export type ExecutorDeploymentProfile = z.infer<typeof ExecutorDeploymentProfileSchema>;

export interface DefineExecutorDeploymentProfileInput {
  readonly tenantId: string;
  readonly executorOrigin: string;
  readonly opaqueConnectionRef: string;
  readonly backupPolicyId: string;
  readonly receipt: ExecutorSelfHostConformanceReceipt;
  readonly evaluatedAt: string;
}

function normalizedProductionOrigin(value: string): string {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new ExecutorAdapterError(
      "KAF_EXECUTOR_DEPLOYMENT_NOT_READY",
      "Production Executor origin must be an exact credential-free HTTPS origin",
    );
  }
  return origin.origin;
}

function connectionBindingDigest(input: {
  readonly tenantId: string;
  readonly executorOrigin: string;
  readonly opaqueConnectionRef: string;
}): Digest {
  return digestCanonicalJson({
    bindingFormat: "pactmark.executor-sh-connection-binding@1",
    tenantId: IdentifierSchema.parse(input.tenantId),
    executorOrigin: normalizedProductionOrigin(input.executorOrigin),
    opaqueConnectionRef: IdentifierSchema.parse(input.opaqueConnectionRef),
  });
}

export function defineExecutorDeploymentProfile(
  input: DefineExecutorDeploymentProfileInput,
): ExecutorDeploymentProfile {
  const receipt = verifyExecutorSelfHostConformanceReceipt(input.receipt, input.evaluatedAt);
  const executorOrigin = normalizedProductionOrigin(input.executorOrigin);
  const material = ExecutorDeploymentProfileMaterialSchema.parse({
    schemaVersion: "1",
    profileFormat: "pactmark.executor-sh-deployment@1",
    runtimeProfile: "production",
    tenantId: input.tenantId,
    executorOrigin,
    opaqueConnectionRef: input.opaqueConnectionRef,
    connectionBindingDigest: connectionBindingDigest({
      tenantId: input.tenantId,
      executorOrigin,
      opaqueConnectionRef: input.opaqueConnectionRef,
    }),
    conformanceReceiptDigest: receipt.executorSelfHostConformanceReceiptDigest,
    platform: receipt.platform,
    tenantIsolation: "instance_per_tenant",
    telemetry: "disabled",
    analyticsOptOut: "DO_NOT_TRACK",
    localNetworkAccess: "disabled",
    stdioMcp: "disabled",
    tls: "system_trusted_https",
    processUser: "65532:65532",
    readOnlyRootFilesystem: true,
    capabilitiesDropped: "ALL",
    noNewPrivileges: true,
    dataVolume: "dedicated_encrypted",
    backupPolicyId: input.backupPolicyId,
  });
  return deepFreeze(
    ExecutorDeploymentProfileSchema.parse({
      ...material,
      executorDeploymentProfileDigest: digestCanonicalJson(material),
    }),
  );
}

export function verifyExecutorDeployment(
  profileInput: ExecutorDeploymentProfile,
  receiptInput: ExecutorSelfHostConformanceReceipt,
  evaluatedAt: string,
): Readonly<{
  profile: ExecutorDeploymentProfile;
  receipt: ExecutorSelfHostConformanceReceipt;
}> {
  let profile: ExecutorDeploymentProfile;
  try {
    profile = ExecutorDeploymentProfileSchema.parse(profileInput);
  } catch {
    throw new ExecutorAdapterError(
      "KAF_EXECUTOR_DEPLOYMENT_NOT_READY",
      "Executor production deployment profile is malformed",
    );
  }
  const receipt = verifyExecutorSelfHostConformanceReceipt(receiptInput, evaluatedAt);
  const { executorDeploymentProfileDigest: claimed, ...material } = profile;
  const valid =
    digestCanonicalJson(material) === claimed &&
    profile.executorOrigin === normalizedProductionOrigin(profile.executorOrigin) &&
    profile.connectionBindingDigest === connectionBindingDigest(profile) &&
    profile.conformanceReceiptDigest === receipt.executorSelfHostConformanceReceiptDigest &&
    profile.platform === receipt.platform;
  if (!valid) {
    throw new ExecutorAdapterError(
      "KAF_EXECUTOR_DEPLOYMENT_NOT_READY",
      "Executor deployment profile does not match its receipt or connection binding",
    );
  }
  return deepFreeze({ profile, receipt });
}
