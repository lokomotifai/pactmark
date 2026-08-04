import { describe, expect, it } from "vitest";

import {
  PatternRecordSchema,
  VerificationRecordSchema,
  digestCanonicalJson,
} from "../src/index.js";

const instant = "2026-08-03T10:00:00.000Z";
const d = (value: unknown) => digestCanonicalJson(value);

describe("evidence storage routing contracts", () => {
  it("requires tenant, purpose, and permitted data classification around verification results", () => {
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
    const record = {
      schemaVersion: "1" as const,
      tenantId: "tenant-a",
      runId: "run-1",
      purposeCode: "support",
      dataClass: "internal" as const,
      verification: {
        ...verificationMaterial,
        verificationDigest: d(verificationMaterial),
      },
    };
    expect(VerificationRecordSchema.parse(record)).toEqual(record);
    expect(
      VerificationRecordSchema.safeParse({ ...record, dataClass: "highly_restricted" }).success,
    ).toBe(false);
  });

  it("routes each immutable pattern manifest version through an explicit tenant", () => {
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
    const record = {
      schemaVersion: "1" as const,
      tenantId: "tenant-a",
      purposeCode: "support",
      dataClass: "internal" as const,
      pattern: { ...patternMaterial, patternDigest: d(patternMaterial) },
    };
    expect(PatternRecordSchema.parse(record)).toEqual(record);
    expect(PatternRecordSchema.safeParse({ ...record, tenantId: "" }).success).toBe(false);
  });
});
