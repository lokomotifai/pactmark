import { describe, expect, it } from "vitest";

import { digestCanonicalJson } from "@pactmark/core";

import {
  EXECUTOR_SELF_HOST_IMAGE,
  EXECUTOR_SELF_HOST_IMAGE_INDEX_DIGEST,
  EXECUTOR_SELF_HOST_SOURCE_REVISION,
  EXECUTOR_SELF_HOST_VERSION,
  defineExecutorDeploymentProfile,
  defineExecutorSelfHostConformanceReceipt,
  executorConnectionBindingDigest,
  executorSelfHostManifestDigest,
  verifyExecutorDeployment,
  verifyExecutorSelfHostConformanceReceipt,
  type ExecutorDeploymentProfile,
  type ExecutorSelfHostConformanceReceipt,
} from "../src/index.js";

const checks = {
  imagePinMatched: true,
  sourceRevisionMatched: true,
  mainProcessNonRoot: true,
  readOnlyRootFilesystem: true,
  capabilitiesDropped: true,
  noNewPrivileges: true,
  resourceLimitsApplied: true,
  dedicatedDataVolume: true,
  restartPersistence: true,
  backupRestore: true,
  telemetryDisabled: true,
  analyticsIdAbsent: true,
  outboundNetworkDenied: true,
  privateNetworkDenied: true,
  stdioMcpDisabled: true,
  bootstrapCompleted: true,
  unauthenticatedMcpDenied: true,
  apiKeyMcpAuthenticated: true,
  oauthPkceAuthenticated: true,
  crossTenantCredentialDenied: true,
  credentialCanariesAbsent: true,
  executeEnvelopeMatched: true,
} as const;

function receipt() {
  return defineExecutorSelfHostConformanceReceipt({
    platform: "linux/amd64",
    containerRuntimeVersion: "29.3.1",
    environmentDigest: digestCanonicalJson("production-host-a"),
    observedAt: "2026-08-11T16:00:00.000Z",
    expiresAt: "2026-08-18T15:59:59.000Z",
    checks,
  });
}

describe("Executor production deployment contracts", () => {
  it("binds the exact upstream release, platform manifest, tenant, and HTTPS origin", () => {
    const conformance = receipt();
    const profile = defineExecutorDeploymentProfile({
      tenantId: "tenant-a",
      executorOrigin: "https://executor.tenant-a.example",
      opaqueConnectionRef: "primary",
      backupPolicyId: "executor-backup-daily",
      receipt: conformance,
      evaluatedAt: "2026-08-11T16:30:00.000Z",
    });

    expect(EXECUTOR_SELF_HOST_VERSION).toBe("1.5.40");
    expect(EXECUTOR_SELF_HOST_SOURCE_REVISION).toHaveLength(40);
    expect(EXECUTOR_SELF_HOST_IMAGE).toContain(EXECUTOR_SELF_HOST_IMAGE_INDEX_DIGEST);
    expect(conformance.imageManifestDigest).toBe(executorSelfHostManifestDigest("linux/amd64"));
    expect(profile.connectionBindingDigest).toBe(
      executorConnectionBindingDigest({
        tenantId: "tenant-a",
        executorOrigin: "https://executor.tenant-a.example",
        opaqueConnectionRef: "primary",
      }),
    );
    expect(verifyExecutorDeployment(profile, conformance, "2026-08-11T16:30:00.000Z")).toEqual({
      profile,
      receipt: conformance,
    });
  });

  it("rejects malformed, drifted, expired, future, and overlong receipts", () => {
    const conformance = receipt();
    expect(() =>
      verifyExecutorSelfHostConformanceReceipt(
        { ...conformance, containerRuntimeVersion: "drifted" },
        "2026-08-11T16:30:00.000Z",
      ),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_DEPLOYMENT_NOT_READY" }));
    expect(() =>
      verifyExecutorSelfHostConformanceReceipt(conformance, "2026-08-18T15:59:59.000Z"),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_DEPLOYMENT_NOT_READY" }));
    expect(() =>
      verifyExecutorSelfHostConformanceReceipt(conformance, "2026-08-11T15:59:59.000Z"),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_DEPLOYMENT_NOT_READY" }));
    expect(() =>
      defineExecutorSelfHostConformanceReceipt({
        platform: "linux/amd64",
        containerRuntimeVersion: "29.3.1",
        environmentDigest: digestCanonicalJson("host"),
        observedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-08-09T00:00:00.000Z",
        checks,
      }),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_DEPLOYMENT_NOT_READY" }));
    expect(() =>
      verifyExecutorSelfHostConformanceReceipt(
        {} as ExecutorSelfHostConformanceReceipt,
        "2026-08-11T16:30:00.000Z",
      ),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_DEPLOYMENT_NOT_READY" }));
  });

  it("rejects origin, profile, binding, receipt, and platform drift", () => {
    const conformance = receipt();
    expect(() =>
      defineExecutorDeploymentProfile({
        tenantId: "tenant-a",
        executorOrigin: "http://executor.tenant-a.example",
        opaqueConnectionRef: "primary",
        backupPolicyId: "executor-backup-daily",
        receipt: conformance,
        evaluatedAt: "2026-08-11T16:30:00.000Z",
      }),
    ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_DEPLOYMENT_NOT_READY" }));

    const profile = defineExecutorDeploymentProfile({
      tenantId: "tenant-a",
      executorOrigin: "https://executor.tenant-a.example",
      opaqueConnectionRef: "primary",
      backupPolicyId: "executor-backup-daily",
      receipt: conformance,
      evaluatedAt: "2026-08-11T16:30:00.000Z",
    });
    for (const drifted of [
      { ...profile, tenantId: "tenant-b" },
      { ...profile, conformanceReceiptDigest: digestCanonicalJson("other-receipt") },
      { ...profile, platform: "linux/arm64" as const },
      {},
    ]) {
      expect(() =>
        verifyExecutorDeployment(
          drifted as ExecutorDeploymentProfile,
          conformance,
          "2026-08-11T16:30:00.000Z",
        ),
      ).toThrow(expect.objectContaining({ code: "KAF_EXECUTOR_DEPLOYMENT_NOT_READY" }));
    }
  });
});
