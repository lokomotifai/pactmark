import {
  defineStorageSecurityProfile,
  KafError,
  StorageSecurityProfileSchema,
  type RuntimeCapabilities,
  type StorageSecurityProfile,
} from "@pactmark/core";
import type { PoolConfig } from "pg";

export const POSTGRES_STORE_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  schemaVersion: "1",
  executionProfile: "resumable",
  durableStorage: true,
  protectedContext: true,
  protectedWorkOrders: true,
  protectedInputSubmissions: true,
  streaming: false,
  cancellation: false,
  sandbox: "unsafe_local",
  networkPolicy: "none",
  backgroundWakeup: false,
  atomicCommandAndWakeup: true,
  humanDecisions: false,
  typedInput: true,
  effectReconciliation: false,
  compensation: false,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none",
  transactionDomains: ["postgres.main"],
});

export type PostgresConnectionConfig = Readonly<{
  profile: "production" | "development";
  connectionString: string;
  ssl: Readonly<{ mode: "verify-full"; ca?: string }> | Readonly<{ mode: "disable" }>;
  maxConnections?: number;
  applicationName?: string;
}>;

export function validatePostgresConnectionConfig(
  input: unknown,
): asserts input is PostgresConnectionConfig {
  if (!isRecord(input)) throw invalidConfig("config_object");
  assertKnownKeys(input, [
    "profile",
    "connectionString",
    "ssl",
    "maxConnections",
    "applicationName",
  ]);
  if (input.profile !== "production" && input.profile !== "development") {
    throw invalidConfig("profile");
  }
  if (typeof input.connectionString !== "string") throw invalidConfig("connection_string");
  if (!isRecord(input.ssl)) throw invalidConfig("ssl");
  assertKnownKeys(input.ssl, ["mode", "ca"]);
  if (input.ssl.mode !== "verify-full" && input.ssl.mode !== "disable") {
    throw invalidConfig("ssl_mode");
  }
  const caBundle = input.ssl.ca;
  if (input.ssl.mode === "disable" && "ca" in input.ssl) throw invalidConfig("ssl_ca_without_tls");
  if (input.ssl.mode === "verify-full" && caBundle !== undefined && typeof caBundle !== "string") {
    throw invalidConfig("ca_bundle");
  }
  if (input.maxConnections !== undefined && typeof input.maxConnections !== "number") {
    throw invalidConfig("max_connections");
  }
  if (input.applicationName !== undefined && typeof input.applicationName !== "string") {
    throw invalidConfig("application_name");
  }
  let url: URL;
  try {
    url = new URL(input.connectionString);
  } catch (internalCause) {
    throw invalidConfig("connection_string", internalCause);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname.length === 0) {
    throw invalidConfig("connection_string");
  }
  const forbidden = new Set(["ssl", "tls", "sslmode", "sslcert", "sslkey", "sslrootcert"]);
  if ([...url.searchParams.keys()].some((key) => forbidden.has(key.toLowerCase()))) {
    throw invalidConfig("ssl_url_override");
  }
  if (input.ssl.mode === "disable") {
    if (input.profile === "production") throw invalidConfig("production_tls_required");
    if (!isLoopback(url.hostname)) throw invalidConfig("plaintext_requires_loopback");
  } else if (typeof caBundle === "string" && caBundle.trim().length === 0) {
    throw invalidConfig("empty_ca_bundle");
  }
  if (
    input.maxConnections !== undefined &&
    (!Number.isSafeInteger(input.maxConnections) || input.maxConnections <= 0)
  ) {
    throw invalidConfig("max_connections");
  }
  if (input.applicationName !== undefined && input.applicationName.trim().length === 0) {
    throw invalidConfig("application_name");
  }
}

export function toPgPoolConfig(input: PostgresConnectionConfig): PoolConfig {
  validatePostgresConnectionConfig(input);
  return {
    connectionString: input.connectionString,
    ssl:
      input.ssl.mode === "disable"
        ? false
        : {
            rejectUnauthorized: true,
            servername: new URL(input.connectionString).hostname,
            ...(input.ssl.ca === undefined ? {} : { ca: input.ssl.ca }),
          },
    ...(input.maxConnections === undefined ? {} : { max: input.maxConnections }),
    ...(input.applicationName === undefined
      ? {}
      : { application_name: input.applicationName.trim() }),
  };
}

export interface PostgresStorageProfileOptions {
  readonly id?: string;
  readonly allowedDataClasses?: readonly ("public" | "internal" | "confidential" | "restricted")[];
  readonly allowedTenants?: readonly string[];
  readonly allowedPurposes?: readonly string[];
  readonly processingRegion?: string;
  readonly backupResponsibility?: string;
  /** Explicit local-container-only sentinel; it can never satisfy production readiness. */
  readonly transportMode?: "verify-full" | "development-plaintext";
}

export function createPostgresStorageSecurityProfile(
  options: PostgresStorageProfileOptions = {},
): StorageSecurityProfile {
  const developmentPlaintext = options.transportMode === "development-plaintext";
  const profile = defineStorageSecurityProfile({
    id:
      options.id ??
      (developmentPlaintext ? "pactmark.postgres.development-plaintext" : "pactmark.postgres.main"),
    implementationVersion: "0.1.0",
    allowedDataClasses: [
      ...(options.allowedDataClasses ?? ["public", "internal", "confidential", "restricted"]),
    ],
    allowedTenants: [...(options.allowedTenants ?? ["*"])],
    allowedPurposes: [...(options.allowedPurposes ?? ["*"])],
    tenantIsolation: "database_constraint",
    encryptionMode: "application_protected",
    // Core has no plaintext transport claim. `memory` is used as the explicit
    // non-production sentinel rather than falsely advertising verify_full.
    transportSecurity: developmentPlaintext ? "memory" : "verify_full",
    processingRegion: options.processingRegion ?? "operator-configured",
    retentionSupport: true,
    deletionSupport: true,
    backupResponsibility:
      options.backupResponsibility ??
      "Operator must configure, test, and monitor PostgreSQL backups and restore procedures.",
  });
  assertPostgresStorageSecurityProfile(profile, {
    transportMode: developmentPlaintext ? "development-plaintext" : "verify-full",
  });
  return profile;
}

export function assertPostgresStorageSecurityProfile(
  input: unknown,
  expected: Readonly<{ transportMode?: "verify-full" | "development-plaintext" }> = {},
): asserts input is StorageSecurityProfile {
  let profile: StorageSecurityProfile;
  try {
    profile = StorageSecurityProfileSchema.parse(input);
  } catch (internalCause) {
    throw invalidConfig("storage_profile_schema", internalCause);
  }
  const rebuilt = defineStorageSecurityProfile({
    id: profile.id,
    implementationVersion: profile.implementationVersion,
    allowedDataClasses: profile.allowedDataClasses,
    allowedTenants: profile.allowedTenants,
    allowedPurposes: profile.allowedPurposes,
    tenantIsolation: profile.tenantIsolation,
    encryptionMode: profile.encryptionMode,
    transportSecurity: profile.transportSecurity,
    processingRegion: profile.processingRegion,
    retentionSupport: profile.retentionSupport,
    deletionSupport: profile.deletionSupport,
    backupResponsibility: profile.backupResponsibility,
  });
  if (rebuilt.storageSecurityProfileDigest !== profile.storageSecurityProfileDigest) {
    throw invalidConfig("storage_profile_digest");
  }
  if (
    !["database_constraint", "row_level_security"].includes(profile.tenantIsolation) ||
    profile.encryptionMode !== "application_protected" ||
    !profile.retentionSupport ||
    !profile.deletionSupport
  ) {
    throw invalidConfig("storage_profile_incompatible");
  }
  const expectedTransport = expected.transportMode;
  if (expectedTransport === "verify-full" && profile.transportSecurity !== "verify_full") {
    throw invalidConfig("storage_profile_transport_mismatch");
  }
  if (expectedTransport === "development-plaintext" && profile.transportSecurity !== "memory") {
    throw invalidConfig("storage_profile_transport_mismatch");
  }
  if (
    expectedTransport === undefined &&
    profile.transportSecurity !== "verify_full" &&
    profile.transportSecurity !== "memory"
  ) {
    throw invalidConfig("storage_profile_transport_unsupported");
  }
}

export class PostgresStorageGuard {
  constructor(readonly securityProfile: StorageSecurityProfile) {
    assertPostgresStorageSecurityProfile(securityProfile);
  }
  assertTenantAllowed(tenantId: string): void {
    if (tenantId.trim().length === 0 || !matches(this.securityProfile.allowedTenants, tenantId)) {
      this.reject("tenant");
    }
  }
  assertRoutingAllowed(tenantId: string, dataClass: string): void {
    this.assertTenantAllowed(tenantId);
    if (dataClass === "highly_restricted") this.reject("data_class");
    if (!this.securityProfile.allowedDataClasses.includes(dataClass as never))
      this.reject("data_class");
  }
  assertWriteAllowed(tenantId: string, purpose: string, dataClass: string): void {
    this.assertRoutingAllowed(tenantId, dataClass);
    if (purpose.trim().length === 0 || !matches(this.securityProfile.allowedPurposes, purpose)) {
      this.reject("purpose");
    }
  }
  private reject(reason: string): never {
    throw new KafError("KAF_STORAGE_SECURITY_PROFILE", {
      details: { profileId: this.securityProfile.id, reason },
    });
  }
}

function matches(allowed: readonly string[], value: string): boolean {
  return allowed.includes("*") || allowed.includes(value);
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function invalidConfig(reason: string, internalCause?: unknown): KafError {
  return new KafError("KAF_STORAGE_SECURITY_PROFILE", {
    details: { reason },
    ...(internalCause === undefined ? {} : { internalCause }),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  knownKeys: readonly string[],
): void {
  const known = new Set(knownKeys);
  if (Object.keys(value).some((key) => !known.has(key))) throw invalidConfig("unknown_option");
}
