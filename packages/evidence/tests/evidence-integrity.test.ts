import { describe, expect, it } from "vitest";

import {
  ApprovalSchema,
  EvidenceRecordSchema,
  PatternManifestSchema,
  RunEventSchema,
  VerificationExceptionSchema,
  digestBytes,
  digestCanonicalJson,
  type Approval,
  type Artifact,
  type EvidenceRecord,
  type RunEvent,
  type VerificationException,
  type VerificationResult,
} from "@pactmark/core";

import {
  VerifierRegistry,
  buildEvidenceRecord,
  createArtifact,
  createArtifactIntegrityVerifier,
  createEvidenceExport,
  createHumanReviewVerifier,
  createVerificationException,
  exportRedactedEvidenceJson,
  exportRedactedEvidenceMarkdown,
  promotePattern,
  verifierReferenceIdentity,
  verificationExceptionReference,
  verificationResultIdentity,
  verifyEvidenceDigest,
  verifyEvidenceExportDigest,
  verifyVerificationExceptionDigest,
  type EvidenceMaterial,
  type VerifierDefinition,
} from "../src/index.js";

const instant = "2026-08-03T12:00:00.000Z";
const d = (value: unknown) => digestCanonicalJson(value);
const executionDefinition = Object.freeze({
  kind: "agent" as const,
  id: "evidence-integrity-agent",
  version: "1.0.0",
  agentDefinitionDigest: d("agent-definition"),
});
const executionDefinitionDigest = d(executionDefinition);
const workOrderBindingDigest = d("work-order-binding");
const bytes = new TextEncoder().encode('{"result":"verified"}');

function artifact(): Artifact {
  return createArtifact(
    {
      schemaVersion: "1",
      artifactId: "artifact-1",
      mediaType: "application/json",
      location: { kind: "store", storeId: "fixture", objectRef: "artifact-1" },
      tenantId: "tenant-1",
      producingRunId: "run-1",
      producingStepId: "step-1",
      owner: { type: "principal", id: "user-1" },
      visibility: "private",
      dataClass: "internal",
      purposeCode: "testing",
      retention: { mode: "session" },
      provenance: {
        schemaVersion: "1",
        executionDefinition,
        executionDefinitionDigest,
        workOrderBindingDigest,
        producingEventId: "artifact-event",
        sourceArtifactDigests: [],
        toolRegistrationDigests: [],
        metadata: {},
      },
      createdAt: instant,
    },
    bytes,
  );
}

function material(
  riskClass: "low" | "high" | "critical" = "low",
  reviewer = false,
): EvidenceMaterial {
  return {
    schemaVersion: "1",
    evidenceRecordId: "evidence-1",
    tenantId: "tenant-1",
    runId: "run-1",
    executionDefinition,
    executionDefinitionDigest,
    workOrderBindingDigest,
    claim: {
      statement: "SECRET_CLAIM exact output passed its declared verifier",
      claimType: "technical_verification",
      scope: "SECRET_SCOPE one run and one artifact",
    },
    supports: ["SECRET_SUPPORT exact artifact verification"],
    doesNotProve: ["SECRET_LIMIT factual correctness"],
    context: {
      roleFamily: "research",
      workflowId: "fixture",
      riskClass,
      purposeCode: "testing",
    },
    workSplit: {
      ai: { kind: "unavailable", reason: "not_collected" },
      human: { kind: "numeric", value: 0, unit: "minutes" },
      description: "SECRET_SPLIT no inferred effort",
    },
    ...(reviewer
      ? {
          reviewer: {
            reviewerId: "SECRET_REVIEWER",
            role: "quality-reviewer",
            conflictOfInterest: "declared" as const,
            conflictDetails: "SECRET_CONFLICT",
          },
        }
      : {}),
    permission: {
      purposeCode: "testing",
      purposeRegistryVersion: "1",
      visibility: "private",
      dataClass: "internal",
      retention: { mode: "session" },
    },
    freshness: { observedAt: instant, validAt: instant },
    observation: {
      firstObservedAt: instant,
      lastObservedAt: instant,
      count: 1,
      repetitionStatus: "single",
      independentObservationIds: ["observation-1"],
    },
    createdAt: instant,
  };
}

function acceptedEvent(requiredVerifierIds: readonly string[]): RunEvent {
  return RunEventSchema.parse({
    schemaVersion: "1",
    eventId: "accepted-event",
    eventType: "RunAccepted",
    runId: "run-1",
    sequence: 1,
    occurredAt: instant,
    correlationId: "correlation-1",
    tenantId: "tenant-1",
    dataClass: "internal",
    executionDefinition,
    executionDefinitionDigest,
    payload: {
      workOrderId: "work-order-1",
      workOrderBindingDigest,
      requiredVerifierIds: [...requiredVerifierIds],
    },
  });
}

function artifactEvent(value: Artifact, accepted: RunEvent, sequence = 2): RunEvent {
  return RunEventSchema.parse({
    ...accepted,
    eventId: value.provenance.producingEventId,
    sequence,
    eventType: "ArtifactProduced",
    payload: {
      stepId: value.producingStepId,
      artifactId: value.artifactId,
      artifactDigest: value.artifactDigest,
    },
  });
}

function verificationEvent(value: VerificationResult, accepted: RunEvent, sequence = 3): RunEvent {
  return RunEventSchema.parse({
    ...accepted,
    eventId: `${value.verificationId}-event`,
    sequence,
    eventType: "VerificationRecorded",
    payload: {
      stepId: "step-1",
      verificationId: value.verificationId,
      verifierId: value.verifierId,
      status: value.status,
      verificationDigest: value.verificationDigest,
    },
  });
}

function integrityDefinition(): VerifierDefinition {
  return createArtifactIntegrityVerifier({
    id: "integrity",
    version: "1.0.0",
    verifierRegistrationDigest: d("integrity-registration"),
    rubricDigest: d("integrity-rubric"),
  });
}

function verifyWith(definition: VerifierDefinition, value: Artifact = artifact()) {
  const registry = new VerifierRegistry();
  registry.register(definition);
  return registry.verify(definition.id, definition.version, value, bytes, {
    verifiedAt: instant,
    verificationId: `${definition.id}-result`,
  });
}

function deterministicEvidence(reviewer = false): EvidenceRecord {
  const value = artifact();
  const verification = verifyWith(integrityDefinition(), value);
  const accepted = acceptedEvent([verification.verifierId]);
  return buildEvidenceRecord({
    material: material("low", reviewer),
    artifacts: [value],
    events: [accepted, artifactEvent(value, accepted), verificationEvent(verification, accepted)],
    verifications: [verification],
    verifierReferences: [verificationResultIdentity(verification)],
  });
}

function approval(): Approval {
  return ApprovalSchema.parse({
    schemaVersion: "1",
    id: "approval-1",
    issuerId: "decision-issuer",
    challengeId: "challenge-1",
    challengeProofDigest: d("challenge-proof"),
    binding: {
      schemaVersion: "1",
      tenant: { id: "tenant-1" },
      principal: { type: "user", id: "user-1" },
      runId: "run-1",
      stepId: "step-1",
      decisionId: "decision-1",
      workOrderBindingDigest,
      executionDefinition,
      executionDefinitionDigest,
      toolId: "fixture.write",
      toolVersion: "1",
      toolRegistrationDigest: d("tool-registration"),
      argumentsDigest: d("arguments"),
      targetDigest: d("target"),
      previewDigest: d("preview"),
      purpose: { code: "testing", registryVersion: "1" },
      policyRegistrationDigest: d("policy-registration"),
    },
    approvedBy: { type: "user", id: "reviewer-1" },
    authenticationStrength: "user_presence",
    createdAt: instant,
    expiresAt: "2026-08-03T13:00:00.000Z",
    maximumUses: 1,
  });
}

function exceptionFor(value: Artifact, definition: VerifierDefinition): VerificationException {
  return createVerificationException({
    schemaVersion: "1",
    exceptionId: "exception-1",
    tenantId: "tenant-1",
    runId: "run-1",
    artifactDigest: value.artifactDigest,
    verifierId: definition.id,
    verifierRegistrationDigest: definition.verifierRegistrationDigest,
    rubricVersion: definition.rubricVersion,
    rubricDigest: definition.rubricDigest,
    reviewer: { principalId: "reviewer-1", role: "quality-reviewer" },
    reason: "The deterministic verifier is temporarily unavailable for this artifact only.",
    compensatingControls: ["Manual artifact review before use"],
    issuedAt: "2026-08-03T11:59:00.000Z",
    expiresAt: "2026-08-03T12:30:00.000Z",
  });
}

function exceptionEvent(value: VerificationException, accepted: RunEvent, sequence = 3): RunEvent {
  return RunEventSchema.parse({
    ...accepted,
    eventId: "exception-event",
    sequence,
    eventType: "VerificationExceptionRecorded",
    payload: {
      stepId: "step-1",
      exceptionId: value.exceptionId,
      exceptionDigest: value.exceptionDigest,
      verifierId: value.verifierId,
      verifierRegistrationDigest: value.verifierRegistrationDigest,
      artifactDigest: value.artifactDigest,
      rubricVersion: value.rubricVersion,
      rubricDigest: value.rubricDigest,
      reviewerRole: value.reviewer.role,
      expiresAt: value.expiresAt,
      reason: value.reason,
      compensatingControls: value.compensatingControls,
    },
  });
}

describe("strict EvidenceRecord referential integrity", () => {
  it("recomputes artifact, execution, verification and approval bindings", () => {
    const value = artifact();
    const verification = verifyWith(integrityDefinition(), value);
    const accepted = acceptedEvent([verification.verifierId]);
    const approved = approval();
    const events = [
      accepted,
      artifactEvent(value, accepted),
      verificationEvent(verification, accepted),
      RunEventSchema.parse({
        ...accepted,
        eventId: "approval-event",
        sequence: 4,
        eventType: "ApprovalRecorded",
        payload: {
          stepId: approved.binding.stepId,
          decisionId: approved.binding.decisionId,
          approvalId: approved.id,
          resumeTarget: "running",
        },
      }),
    ];
    const input = {
      material: material(),
      artifacts: [value],
      events,
      approvals: [approved],
      verifications: [verification],
      verifierReferences: [verificationResultIdentity(verification)],
    } as const;
    const record = buildEvidenceRecord(input);
    expect(verifyEvidenceDigest(record)).toBe(true);
    expect(record.approvalRefs).toEqual([
      { approvalId: approved.id, approvalDigest: d(approved.binding) },
    ]);
    expect(record.verificationRefs[0]).toMatchObject({
      artifactDigest: value.artifactDigest,
      verifierId: verification.verifierId,
      verifierRegistrationDigest: verification.verifierRegistrationDigest,
      rubricVersion: verification.rubricVersion,
      rubricDigest: verification.rubricDigest,
    });

    expect(() =>
      buildEvidenceRecord({
        ...input,
        artifacts: [{ ...value, artifactDigest: d("tampered-artifact") }],
      }),
    ).toThrow("KAF_EVIDENCE_INVALID_REFERENCE");
    expect(() =>
      buildEvidenceRecord({
        ...input,
        verifications: [{ ...verification, verificationDigest: d("tampered-verification") }],
      }),
    ).toThrow("KAF_EVIDENCE_INVALID_REFERENCE");
    expect(() => buildEvidenceRecord({ ...input, events: events.slice(0, 2) })).toThrow(
      "KAF_EVIDENCE_INVALID_REFERENCE",
    );
    expect(() =>
      buildEvidenceRecord({
        ...input,
        verifierReferences: [
          { ...verificationResultIdentity(verification), rubricDigest: d("other-rubric") },
        ],
      }),
    ).toThrow("KAF_EVIDENCE_INVALID_REFERENCE");
    expect(() =>
      buildEvidenceRecord({
        ...input,
        approvals: [{ ...approved, binding: { ...approved.binding, decisionId: "other" } }],
      }),
    ).toThrow("KAF_EVIDENCE_INVALID_REFERENCE");
    expect(() =>
      buildEvidenceRecord({
        ...input,
        approvals: [{ ...approved, expiresAt: instant }],
      }),
    ).toThrow("KAF_EVIDENCE_INVALID_REFERENCE");
    expect(() =>
      buildEvidenceRecord({
        ...input,
        events: events.map((event) =>
          event.eventId === "accepted-event"
            ? {
                ...event,
                executionDefinition: { ...executionDefinition, version: "other" },
              }
            : event,
        ),
      }),
    ).toThrow("KAF_EVIDENCE_INVALID_REFERENCE");
  });
});

describe("human review and verification exceptions", () => {
  it("requires a reviewer identity and permits human verification at high risk", () => {
    const value = artifact();
    const definition = createHumanReviewVerifier({
      id: "human-review",
      version: "1.0.0",
      verifierRegistrationDigest: d("human-registration"),
      rubricVersion: "1",
      rubricDigest: d("human-rubric"),
      review: () => [],
    });
    const registry = new VerifierRegistry();
    registry.register(definition);
    expect(() =>
      registry.verify(definition.id, definition.version, value, bytes, {
        verifiedAt: instant,
        verificationId: "human-result",
      }),
    ).toThrow("KAF_HUMAN_REVIEWER_REQUIRED");
    const verification = registry.verify(definition.id, definition.version, value, bytes, {
      verifiedAt: instant,
      verificationId: "human-result",
      reviewerId: "reviewer-1",
    });
    const accepted = acceptedEvent([definition.id]);
    const record = buildEvidenceRecord({
      material: material("high", true),
      artifacts: [value],
      events: [accepted, artifactEvent(value, accepted), verificationEvent(verification, accepted)],
      verifications: [verification],
      verifierReferences: [verifierReferenceIdentity(definition)],
    });
    expect(verification).toMatchObject({ status: "pass", method: "human" });
    expect(record.verificationRefs).toHaveLength(1);
  });

  it("binds a short-lived exception to one tenant, run, artifact, verifier and rubric", () => {
    const value = artifact();
    const definition = integrityDefinition();
    const exception = exceptionFor(value, definition);
    const accepted = acceptedEvent([definition.id]);
    const events = [accepted, artifactEvent(value, accepted), exceptionEvent(exception, accepted)];
    const input = {
      material: {
        ...material(),
        supports: ["exception-1 records a bounded temporary verification exception"],
        doesNotProve: ["exception-1 does not prove that the deterministic verifier passed"],
      },
      artifacts: [value],
      events,
      verifications: [],
      verificationExceptions: [exception],
      verifierReferences: [verifierReferenceIdentity(definition)],
    } as const;
    const record = buildEvidenceRecord(input);
    expect(verifyVerificationExceptionDigest(exception)).toBe(true);
    expect(verificationExceptionReference(exception)).toEqual(record.verificationExceptionRefs[0]);

    expect(() =>
      buildEvidenceRecord({
        ...input,
        material: {
          ...input.material,
          context: { ...input.material.context, riskClass: "high" },
        },
      }),
    ).toThrow("KAF_VERIFICATION_REQUIRED");
    for (const changed of [
      { ...exception, tenantId: "other-tenant" },
      { ...exception, runId: "other-run" },
      { ...exception, artifactDigest: d("other-artifact") },
      { ...exception, rubricDigest: d("other-rubric") },
      { ...exception, expiresAt: instant },
    ]) {
      expect(() => buildEvidenceRecord({ ...input, verificationExceptions: [changed] })).toThrow(
        "KAF_EVIDENCE_INVALID_REFERENCE",
      );
    }
    expect(() =>
      createVerificationException({
        ...exception,
        exceptionId: "invalid-window",
        issuedAt: exception.expiresAt,
        expiresAt: exception.issuedAt,
      }),
    ).toThrow("KAF_VERIFICATION_EXCEPTION_WINDOW_INVALID");

    expect(
      VerificationExceptionSchema.safeParse({
        ...exception,
        issuedAt: exception.expiresAt,
      }).success,
    ).toBe(false);

    const registry = new VerifierRegistry();
    registry.register(definition);
    const failed = registry.verify(definition.id, definition.version, value, new Uint8Array([1]), {
      verifiedAt: instant,
      verificationId: "failed-integrity",
    });
    expect(failed.status).toBe("fail");
    expect(() =>
      buildEvidenceRecord({
        ...input,
        events: [...events, verificationEvent(failed, accepted, 4)],
        verifications: [failed],
      }),
    ).toThrow();
  });
});

describe("typed source-side evidence export", () => {
  it("redacts only allowed typed fields before deterministic JSON and Markdown serialization", () => {
    const record = deterministicEvidence(true);
    const rules = [
      { path: ["reviewer", "reviewerId"] as const },
      { path: ["reviewer", "conflictDetails"] as const },
      { path: ["claim", "statement"] as const },
      { path: ["claim", "scope"] as const },
      { path: ["supports", 0] as const },
      { path: ["doesNotProve", 0] as const },
      { path: ["workSplit", "description"] as const },
    ];
    const exported = createEvidenceExport(record, rules);
    const json = exportRedactedEvidenceJson(record, rules);
    const markdown = exportRedactedEvidenceMarkdown(record, rules);
    expect(verifyEvidenceExportDigest(exported)).toBe(true);
    expect(verifyEvidenceDigest(record)).toBe(true);
    expect(record.reviewer?.reviewerId).toBe("SECRET_REVIEWER");
    expect(exportRedactedEvidenceJson(record, rules)).toBe(json);
    expect(exportRedactedEvidenceMarkdown(record, rules)).toBe(markdown);
    expect(digestBytes(new TextEncoder().encode(json))).toBe(
      digestBytes(new TextEncoder().encode(exportRedactedEvidenceJson(record, rules))),
    );
    expect(digestBytes(new TextEncoder().encode(markdown))).toBe(
      digestBytes(new TextEncoder().encode(exportRedactedEvidenceMarkdown(record, rules))),
    );
    for (const canary of [
      "SECRET_REVIEWER",
      "SECRET_CONFLICT",
      "SECRET_CLAIM",
      "SECRET_SCOPE",
      "SECRET_SUPPORT",
      "SECRET_LIMIT",
      "SECRET_SPLIT",
    ]) {
      expect(json).not.toContain(canary);
      expect(markdown).not.toContain(canary);
    }
    expect(() => createEvidenceExport(record, [{ path: ["executionDefinitionDigest"] }])).toThrow(
      "KAF_EVIDENCE_REDACTION_PATH_FORBIDDEN",
    );
  });

  it("preserves explicit unavailable reasons and numeric zero as distinct values", () => {
    const original = deterministicEvidence();
    const reasons = ["not_collected", "not_permitted", "not_applicable", "unknown"] as const;
    for (const reason of reasons) {
      const { evidenceDigest: _digest, ...base } = original;
      const candidateMaterial = {
        ...base,
        evidenceRecordId: `evidence-${reason}`,
        workSplit: {
          ...base.workSplit,
          ai: { kind: "unavailable" as const, reason },
          human: { kind: "numeric" as const, value: 0, unit: "minutes" },
        },
      };
      const candidate = EvidenceRecordSchema.parse({
        ...candidateMaterial,
        evidenceDigest: d(candidateMaterial),
      });
      const exported = createEvidenceExport(candidate, []);
      expect(exported.evidence.workSplit.ai).toEqual({ kind: "unavailable", reason });
      expect(exported.evidence.workSplit.human).toEqual({
        kind: "numeric",
        value: 0,
        unit: "minutes",
      });
      void _digest;
    }
  });

  it("enforces reviewer conflict state at the public runtime schema boundary", () => {
    const record = deterministicEvidence();
    expect(
      EvidenceRecordSchema.safeParse({
        ...record,
        reviewer: {
          reviewerId: "reviewer-1",
          role: "quality-reviewer",
          conflictOfInterest: "declared",
        },
      }).success,
    ).toBe(false);
    expect(
      EvidenceRecordSchema.safeParse({
        ...record,
        reviewer: {
          reviewerId: "reviewer-1",
          role: "quality-reviewer",
          conflictOfInterest: "none_declared",
          conflictDetails: "This state contradicts the supplied details.",
        },
      }).success,
    ).toBe(false);
  });
});

describe("pattern promotion evidence", () => {
  function observedCopy(
    source: EvidenceRecord,
    id: string,
    observationId: string,
    workflowId = source.context.workflowId,
  ): EvidenceRecord {
    const { evidenceDigest: _digest, ...base } = source;
    const changed = {
      ...base,
      evidenceRecordId: id,
      context: { ...base.context, workflowId },
      observation: {
        ...base.observation,
        independentObservationIds: [observationId],
      },
    };
    void _digest;
    return EvidenceRecordSchema.parse({ ...changed, evidenceDigest: d(changed) });
  }

  it("denies different-scale repetition and requires measured baseline advantage for proven", () => {
    const first = deterministicEvidence();
    const sameScale = observedCopy(first, "evidence-2", "observation-2");
    const otherScale = observedCopy(first, "evidence-3", "observation-3", "other-workflow");
    const peerReviewed = PatternManifestSchema.parse({
      schemaVersion: "1",
      patternId: "fixture-pattern",
      version: "1.0.0",
      patternDigest: d("pattern"),
      title: "Fixture pattern",
      description: "A narrowly scoped fixture pattern",
      maturity: "peer_reviewed",
      scaleUnit: { roleFamily: "research", workflowId: "fixture", riskClass: "low" },
      assetRefs: [
        { kind: "agent", id: executionDefinition.id, version: "1.0.0", digest: d("agent") },
      ],
      evidenceRecordDigests: [first.evidenceDigest],
      independentObservationCount: 1,
      supportedClaims: ["Produces an integrity-verified fixture"],
      doesNotProve: ["Production benefit"],
      createdAt: instant,
      updatedAt: instant,
    });
    expect(() => promotePattern(peerReviewed, "repeated", [first, otherScale], instant)).toThrow();
    const repeated = promotePattern(peerReviewed, "repeated", [first, sameScale], instant);
    expect(() => promotePattern(repeated, "proven", [first, sameScale], instant)).toThrow();
    expect(() =>
      PatternManifestSchema.parse({
        ...repeated,
        baseline: {
          metric: "quality",
          description: "Declared deterministic baseline",
          baselineDigest: d("baseline"),
          advantageEvidenceDigest: sameScale.evidenceDigest,
          measuredAdvantage: 0,
          unit: "percentage-point",
        },
      }),
    ).toThrow();
    const withBaseline = PatternManifestSchema.parse({
      ...repeated,
      baseline: {
        metric: "quality",
        description: "Declared deterministic baseline",
        baselineDigest: d("baseline"),
        advantageEvidenceDigest: sameScale.evidenceDigest,
        measuredAdvantage: 1,
        unit: "percentage-point",
      },
    });
    const proven = promotePattern(withBaseline, "proven", [first, sameScale], instant);
    expect(proven.maturity).toBe("proven");
    expect(() =>
      promotePattern(
        {
          ...withBaseline,
          baseline: { ...withBaseline.baseline, advantageEvidenceDigest: d("unrelated") },
        },
        "proven",
        [first, sameScale],
        instant,
      ),
    ).toThrow("KAF_PATTERN_INSUFFICIENT_EVIDENCE");
    expect(() =>
      promotePattern(
        withBaseline,
        "proven",
        [{ ...sameScale, evidenceDigest: d("tampered") }],
        instant,
      ),
    ).toThrow("KAF_EVIDENCE_DIGEST_INVALID");
  });
});
