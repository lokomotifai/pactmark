import {
  digestCanonicalJson,
  type EvidenceRecord,
  type PatternRecord,
  type VerificationRecord,
} from "@pactmark/core";
import { describe, expect, it } from "vitest";

import {
  MemoryEvidenceRecordStore,
  MemoryPatternRecordStore,
  MemoryVerificationRecordStore,
  createMemoryStorageSecurityProfile,
} from "../src/index.js";

const instant = "2026-08-03T10:00:00.000Z";
const d = (value: unknown) => digestCanonicalJson(value);

function verificationRecord(tenantId = "tenant-a", runId = "run-1"): VerificationRecord {
  const verificationMaterial = {
    schemaVersion: "1" as const,
    status: "pass" as const,
    verificationId: "verification-1",
    verifierId: "integrity",
    verifierVersion: "1",
    verifierRegistrationDigest: d("verifier"),
    method: "deterministic" as const,
    artifactDigest: d("artifact"),
    findings: [],
    rubricVersion: "1",
    rubricDigest: d("rubric"),
    verifiedAt: instant,
  };
  return {
    schemaVersion: "1",
    tenantId,
    runId,
    purposeCode: "support",
    dataClass: "internal",
    verification: {
      ...verificationMaterial,
      verificationDigest: d(verificationMaterial),
    },
  };
}

function patternRecord(tenantId = "tenant-a"): PatternRecord {
  const patternMaterial = {
    schemaVersion: "1" as const,
    patternId: "pattern-1",
    version: "1",
    title: "Support triage",
    description: "A bounded fixture pattern",
    maturity: "candidate" as const,
    scaleUnit: { roleFamily: "support", workflowId: "triage", riskClass: "low" as const },
    assetRefs: [{ kind: "agent" as const, id: "agent-1", version: "1", digest: d("agent") }],
    evidenceRecordDigests: [],
    independentObservationCount: 0,
    supportedClaims: ["Supports fixture testing"],
    doesNotProve: ["Production effectiveness"],
    createdAt: instant,
    updatedAt: instant,
  };
  return {
    schemaVersion: "1",
    tenantId,
    purposeCode: "support",
    dataClass: "internal",
    pattern: { ...patternMaterial, patternDigest: d(patternMaterial) },
  };
}

function evidenceRecord(tenantId = "tenant-a"): EvidenceRecord {
  const material = {
    schemaVersion: "1" as const,
    evidenceRecordId: "evidence-1",
    tenantId,
    runId: "run-1",
    executionDefinition: {
      kind: "agent" as const,
      id: "agent-1",
      version: "1",
      agentDefinitionDigest: d("agent"),
    },
    executionDefinitionDigest: d("execution"),
    workOrderBindingDigest: d("work-order"),
    claim: { statement: "Fixture completed", claimType: "technical", scope: "one run" },
    supports: ["Artifact integrity"],
    doesNotProve: ["Business outcome"],
    context: {
      roleFamily: "support",
      workflowId: "triage",
      riskClass: "low" as const,
      purposeCode: "support",
    },
    workSplit: {
      ai: { kind: "numeric" as const, value: 1, unit: "step" },
      human: { kind: "numeric" as const, value: 0, unit: "step" },
      description: "Fixture split",
    },
    artifactRefs: [{ artifactId: "artifact-1", artifactDigest: d("artifact") }],
    eventRefs: [{ eventId: "event-1", sequence: 1 }],
    approvalRefs: [],
    verificationRefs: [],
    verificationExceptionRefs: [],
    permission: {
      purposeCode: "support",
      purposeRegistryVersion: "1",
      visibility: "tenant" as const,
      dataClass: "internal" as const,
      retention: { mode: "session" as const },
    },
    freshness: { observedAt: instant, validAt: instant },
    observation: {
      firstObservedAt: instant,
      lastObservedAt: instant,
      count: 1,
      repetitionStatus: "single" as const,
      independentObservationIds: ["observation-1"],
    },
    createdAt: instant,
  };
  return { ...material, evidenceDigest: d(material) };
}

describe("immutable evidence records in memory", () => {
  it("round-trips exact records by route and digest without cross-tenant reads", async () => {
    const profile = createMemoryStorageSecurityProfile({
      allowedTenants: ["tenant-a", "tenant-b"],
    });
    const evidence = new MemoryEvidenceRecordStore(profile);
    const verification = new MemoryVerificationRecordStore(profile);
    const pattern = new MemoryPatternRecordStore(profile);
    const records = [evidenceRecord(), verificationRecord(), patternRecord()] as const;

    await evidence.putImmutable(records[0]);
    await evidence.putImmutable(records[0]);
    await verification.putImmutable(records[1]);
    await verification.putImmutable(records[1]);
    await pattern.putImmutable(records[2]);
    await pattern.putImmutable(records[2]);

    await expect(evidence.get("tenant-a", "evidence-1")).resolves.toEqual(records[0]);
    await expect(evidence.getByDigest("tenant-a", records[0].evidenceDigest)).resolves.toEqual(
      records[0],
    );
    await expect(verification.get("tenant-a", "run-1", "verification-1")).resolves.toEqual(
      records[1],
    );
    await expect(
      verification.getByDigest("tenant-a", records[1].verification.verificationDigest),
    ).resolves.toEqual(records[1]);
    await expect(pattern.get("tenant-a", "pattern-1", "1")).resolves.toEqual(records[2]);
    await expect(
      pattern.getByDigest("tenant-a", records[2].pattern.patternDigest),
    ).resolves.toEqual(records[2]);
    await expect(evidence.get("tenant-b", "evidence-1")).resolves.toBeUndefined();
    await expect(
      verification.getByDigest("tenant-b", records[1].verification.verificationDigest),
    ).resolves.toBeUndefined();
    await expect(pattern.get("tenant-b", "pattern-1", "1")).resolves.toBeUndefined();
  });

  it("rejects digest tampering, same-key mutation, and digest replay on another route", async () => {
    const profile = createMemoryStorageSecurityProfile();
    const evidence = new MemoryEvidenceRecordStore(profile);
    const verification = new MemoryVerificationRecordStore(profile);
    const pattern = new MemoryPatternRecordStore(profile);
    const originalEvidence = evidenceRecord();
    const originalVerification = verificationRecord();
    const originalPattern = patternRecord();
    await evidence.putImmutable(originalEvidence);
    await verification.putImmutable(originalVerification);
    await pattern.putImmutable(originalPattern);

    await expect(
      evidence.putImmutable({ ...originalEvidence, supports: ["Changed without digest"] }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    const { evidenceDigest: _ignoredEvidence, ...originalEvidenceMaterial } = originalEvidence;
    const changedEvidence = {
      ...originalEvidenceMaterial,
      supports: ["Changed with digest"],
    };
    expect(_ignoredEvidence).toBe(originalEvidence.evidenceDigest);
    await expect(
      evidence.putImmutable({ ...changedEvidence, evidenceDigest: d(changedEvidence) }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });

    await expect(
      verification.putImmutable({ ...originalVerification, runId: "run-2" }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
    await expect(
      pattern.putImmutable({
        ...originalPattern,
        pattern: { ...originalPattern.pattern, title: "Tampered" },
      }),
    ).rejects.toMatchObject({ code: "KAF_STORAGE_CONCURRENCY_CONFLICT" });
  });
});
