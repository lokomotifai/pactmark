import {
  defineStorageSecurityProfile,
  KafError,
  type RuntimeCapabilities,
  type StorageSecurityProfile,
} from "@pactmark/core";

export const MEMORY_STORE_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  schemaVersion: "1",
  executionProfile: "ephemeral",
  durableStorage: false,
  protectedContext: true,
  protectedWorkOrders: false,
  protectedInputSubmissions: true,
  streaming: false,
  cancellation: false,
  sandbox: "unsafe_local",
  networkPolicy: "none",
  backgroundWakeup: false,
  atomicCommandAndWakeup: false,
  humanDecisions: false,
  typedInput: true,
  effectReconciliation: false,
  compensation: false,
  modelCredentials: false,
  toolCredentials: false,
  telemetry: "none",
  transactionDomains: ["memory.process-local"],
});

export interface MemoryStorageProfileOptions {
  readonly id?: string;
  readonly allowedDataClasses?: readonly ("public" | "internal" | "confidential" | "restricted")[];
  readonly allowedTenants?: readonly string[];
  readonly allowedPurposes?: readonly string[];
  readonly processingRegion?: string;
}

export function createMemoryStorageSecurityProfile(
  options: MemoryStorageProfileOptions = {},
): StorageSecurityProfile {
  return defineStorageSecurityProfile({
    id: options.id ?? "pactmark.memory.process-local",
    implementationVersion: "0.1.0",
    allowedDataClasses: [...(options.allowedDataClasses ?? ["public", "internal"])],
    allowedTenants: [...(options.allowedTenants ?? ["*"])],
    allowedPurposes: [...(options.allowedPurposes ?? ["*"])],
    tenantIsolation: "process",
    encryptionMode: "none_ephemeral",
    transportSecurity: "memory",
    processingRegion: options.processingRegion ?? "process-local",
    retentionSupport: true,
    deletionSupport: true,
    backupResponsibility: "Unsupported: process-local state is discarded on exit.",
  });
}

export class MemoryStorageGuard {
  constructor(readonly securityProfile: StorageSecurityProfile) {}

  assertWriteAllowed(tenantId: string, purposeCode: string, dataClass: string): void {
    this.assertRoutingAllowed(tenantId, dataClass);
    if (!matches(this.securityProfile.allowedPurposes, purposeCode)) this.reject("purpose");
  }

  assertTenantAllowed(tenantId: string): void {
    if (tenantId.trim().length === 0 || !matches(this.securityProfile.allowedTenants, tenantId)) {
      this.reject("tenant");
    }
  }

  assertRoutingAllowed(tenantId: string, dataClass: string): void {
    this.assertTenantAllowed(tenantId);
    if (dataClass === "highly_restricted") this.reject("data_class");
    if (!this.securityProfile.allowedDataClasses.includes(dataClass as never)) {
      this.reject("data_class");
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
