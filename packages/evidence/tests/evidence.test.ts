import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  PatternManifestSchema,
  RunEventSchema,
  digestCanonicalJson,
  type Artifact,
  type EvidenceRecord,
  type VerificationResult,
} from "@pactmark/core";

import {
  VerifierRegistry,
  artifactProvenanceSummary,
  artifactReference,
  buildEvidenceRecord,
  createArtifact,
  createArtifactIntegrityVerifier,
  createCitationShapeVerifier,
  createModelAssessmentVerifier,
  createRuleVerifier,
  createSchemaConformanceVerifier,
  exportEvidenceJson,
  exportEvidenceMarkdown,
  promotePattern,
  redactCommonSensitiveText,
  redactTypedFields,
  verifyArtifactContent,
  verifyEvidenceDigest,
  verificationReference,
  verificationResultIdentity,
} from "../src/index.js";

const d = (value: unknown) => digestCanonicalJson(value);
const definition = {
  kind: "agent" as const,
  id: "evidence-agent",
  version: "1.0.0",
  agentDefinitionDigest: d("agent"),
};
const content = new TextEncoder().encode(
  JSON.stringify({
    title: "Pactmark",
    citations: [{ title: "Source", url: "https://example.com" }],
  }),
);

function artifactFor(bytes = content): Artifact {
  return createArtifact(
    {
      schemaVersion: "1",
      artifactId: "artifact-1",
      mediaType: "application/json",
      location: { kind: "store", storeId: "memory", objectRef: "artifact-1" },
      tenantId: "tenant-1",
      producingRunId: "run-1",
      producingStepId: "step-1",
      owner: { type: "principal", id: "user-1" },
      visibility: "private",
      dataClass: "internal",
      purposeCode: "service_delivery",
      retention: { mode: "session" },
      provenance: {
        schemaVersion: "1",
        executionDefinition: definition,
        executionDefinitionDigest: d(definition),
        workOrderBindingDigest: d("work-order"),
        producingEventId: "event-2",
        sourceArtifactDigests: [],
        toolRegistrationDigests: [],
        metadata: {},
      },
      createdAt: "2026-08-03T12:00:00Z",
    },
    bytes,
  );
}

function acceptedEvent(requiredVerifierIds: readonly string[] = ["schema"]) {
  return RunEventSchema.parse({
    schemaVersion: "1",
    eventId: "event-1",
    runId: "run-1",
    sequence: 1,
    occurredAt: "2026-08-03T12:00:00Z",
    correlationId: "correlation-1",
    tenantId: "tenant-1",
    dataClass: "internal",
    executionDefinition: definition,
    executionDefinitionDigest: d(definition),
    eventType: "RunAccepted",
    payload: {
      workOrderId: "work-order-1",
      workOrderBindingDigest: d("work-order"),
      requiredVerifierIds: [...requiredVerifierIds],
    },
  });
}

function evidenceEvents(
  artifact: Artifact,
  verifications: readonly VerificationResult[],
  requiredVerifierIds: readonly string[] = verifications.map(
    (verification) => verification.verifierId,
  ),
) {
  const accepted = acceptedEvent(requiredVerifierIds);
  return [
    accepted,
    RunEventSchema.parse({
      ...accepted,
      eventId: artifact.provenance.producingEventId,
      sequence: 2,
      eventType: "ArtifactProduced",
      payload: {
        stepId: artifact.producingStepId,
        artifactId: artifact.artifactId,
        artifactDigest: artifact.artifactDigest,
      },
    }),
    ...verifications.map((verification, index) =>
      RunEventSchema.parse({
        ...accepted,
        eventId: `verification-event-${String(index + 1)}`,
        sequence: index + 3,
        eventType: "VerificationRecorded",
        payload: {
          stepId: artifact.producingStepId,
          verificationId: verification.verificationId,
          verifierId: verification.verifierId,
          status: verification.status,
          verificationDigest: verification.verificationDigest,
        },
      }),
    ),
  ];
}

function evidenceMaterial(riskClass: "low" | "high" | "critical" = "low") {
  return {
    schemaVersion: "1" as const,
    evidenceRecordId: "evidence-1",
    tenantId: "tenant-1",
    runId: "run-1",
    executionDefinition: definition,
    executionDefinitionDigest: d(definition),
    workOrderBindingDigest: d("work-order"),
    claim: {
      statement: "Artifact conforms to its declared schema",
      claimType: "quality",
      scope: "run-1",
    },
    supports: ["The exact artifact passed the registered schema verifier"],
    doesNotProve: ["The cited source is true or complete"],
    context: {
      roleFamily: "research",
      workflowId: "brief",
      riskClass,
      purposeCode: "service_delivery",
    },
    workSplit: {
      ai: { kind: "unavailable" as const, reason: "not_collected" as const },
      human: { kind: "numeric" as const, value: 0, unit: "minutes" },
      description: "No effort attribution was inferred",
    },
    permission: {
      purposeCode: "service_delivery",
      purposeRegistryVersion: "general@1",
      visibility: "private" as const,
      dataClass: "internal" as const,
      retention: { mode: "session" as const },
    },
    freshness: {
      observedAt: "2026-08-03T12:00:00Z",
      validAt: "2026-08-03T12:00:00Z",
    },
    observation: {
      firstObservedAt: "2026-08-03T12:00:00Z",
      lastObservedAt: "2026-08-03T12:00:00Z",
      count: 1,
      repetitionStatus: "single" as const,
      independentObservationIds: ["observation-1"],
    },
    createdAt: "2026-08-03T12:00:00Z",
  };
}

describe("artifacts and verifier registry", () => {
  it("content-addresses artifacts and detects mutation", () => {
    const artifact = artifactFor();
    expect(verifyArtifactContent(artifact, content)).toBe(true);
    expect(verifyArtifactContent(artifact, new TextEncoder().encode("changed"))).toBe(false);
    expect(artifact.artifactDigest).toBe(artifactFor().artifactDigest);
    expect(artifactReference(artifact)).toEqual({
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
    });
    expect(artifactProvenanceSummary(artifact)).toMatchObject({
      workOrderBindingDigest: artifact.provenance.workOrderBindingDigest,
      contentDigest: artifact.contentDigest,
    });
  });

  it("runs deterministic schema, integrity and citation-shape verifiers", () => {
    const artifact = artifactFor();
    const registry = new VerifierRegistry();
    const schemaVerifier = createSchemaConformanceVerifier({
      id: "schema",
      version: "1.0.0",
      verifierRegistrationDigest: d("schema-registration"),
      rubricDigest: d("schema-rubric"),
      schema: z.object({ title: z.string(), citations: z.array(z.unknown()) }),
    });
    registry.register(schemaVerifier);
    registry.register(schemaVerifier);
    registry.register(
      createArtifactIntegrityVerifier({
        id: "integrity",
        version: "1.0.0",
        verifierRegistrationDigest: d("integrity-registration"),
        rubricDigest: d("integrity-rubric"),
      }),
    );
    registry.register(
      createCitationShapeVerifier({
        id: "citations",
        version: "1.0.0",
        verifierRegistrationDigest: d("citation-registration"),
        rubricDigest: d("citation-rubric"),
      }),
    );
    expect(registry.has("schema", "1.0.0")).toBe(true);
    const schemaResult = registry.verify("schema", "1.0.0", artifact, content, {
      verifiedAt: "2026-08-03T12:01:00Z",
      verificationId: "verification-schema",
      reviewerId: "reviewer-1",
    });
    expect(schemaResult.status).toBe("pass");
    expect(verificationReference(schemaResult)).toMatchObject({
      artifactDigest: artifact.artifactDigest,
      method: "deterministic",
    });
    expect(
      registry.verify("integrity", "1.0.0", artifact, new Uint8Array([1]), {
        verifiedAt: "2026-08-03T12:01:00Z",
        verificationId: "verification-integrity",
      }).status,
    ).toBe("fail");
    const citationResult = registry.verify("citations", "1.0.0", artifact, content, {
      verifiedAt: "2026-08-03T12:01:00Z",
      verificationId: "verification-citation",
    });
    expect(citationResult.status).toBe("pass");
    expect(citationResult.findings[0]?.safeMessage).toMatch(/not verified/u);
    expect(() =>
      registry.verify("missing", "1", artifact, content, {
        verifiedAt: "2026-08-03T12:01:00Z",
        verificationId: "missing",
      }),
    ).toThrow("KAF_VERIFIER_NOT_REGISTERED");
    expect(() => {
      registry.register({ ...schemaVerifier, rubricDigest: d("changed") });
    }).toThrow("KAF_REGISTRATION_SAME_VERSION_DRIFT");

    const invalidJson = new TextEncoder().encode("not-json");
    expect(
      registry.verify("schema", "1.0.0", artifactFor(invalidJson), invalidJson, {
        verifiedAt: "2026-08-03T12:01:00Z",
        verificationId: "verification-invalid-json",
      }).status,
    ).toBe("fail");
    const wrongShape = new TextEncoder().encode(JSON.stringify({ title: 42, citations: [] }));
    expect(
      registry.verify("schema", "1.0.0", artifactFor(wrongShape), wrongShape, {
        verifiedAt: "2026-08-03T12:01:00Z",
        verificationId: "verification-wrong-shape",
      }).status,
    ).toBe("fail");

    const httpCitation = new TextEncoder().encode(
      JSON.stringify({ citations: [{ title: "Unsafe", url: "http://example.com" }] }),
    );
    expect(
      registry.verify("citations", "1.0.0", artifactFor(httpCitation), httpCitation, {
        verifiedAt: "2026-08-03T12:01:00Z",
        verificationId: "verification-http-citation",
      }).status,
    ).toBe("fail");
    const invalidCitation = new TextEncoder().encode("not-json");
    expect(
      registry.verify("citations", "1.0.0", artifactFor(invalidCitation), invalidCitation, {
        verifiedAt: "2026-08-03T12:01:00Z",
        verificationId: "verification-invalid-citation",
      }).status,
    ).toBe("fail");
    const emptyCitation = new TextEncoder().encode(JSON.stringify({ citations: [] }));
    expect(
      registry.verify("citations", "1.0.0", artifactFor(emptyCitation), emptyCitation, {
        verifiedAt: "2026-08-03T12:01:00Z",
        verificationId: "verification-empty-citation",
      }).status,
    ).toBe("fail");

    registry.register(
      createRuleVerifier({
        id: "rule",
        version: "1.0.0",
        verifierRegistrationDigest: d("rule-registration"),
        rubricVersion: "1",
        rubricDigest: d("rule-rubric"),
        check: () => [
          {
            schemaVersion: "1",
            code: "KAF_RULE_FAILED",
            severity: "error",
            safeMessage: "Rule failed",
          },
        ],
      }),
    );
    expect(
      registry.verify("rule", "1.0.0", artifact, content, {
        verifiedAt: "2026-08-03T12:01:00Z",
        verificationId: "verification-rule",
      }).status,
    ).toBe("fail");
  });

  it("labels model assessment as needs review", () => {
    const registry = new VerifierRegistry();
    registry.register(
      createModelAssessmentVerifier({
        id: "model-review",
        version: "1.0.0",
        verifierRegistrationDigest: d("model-registration"),
        rubricVersion: "1",
        rubricDigest: d("model-rubric"),
        assess: () => [],
      }),
    );
    expect(
      registry.verify("model-review", "1.0.0", artifactFor(), content, {
        verifiedAt: "2026-08-03T12:01:00Z",
        verificationId: "verification-model",
      }).status,
    ).toBe("needs_review");
  });
});

describe("evidence, redaction and pattern maturity", () => {
  function deterministicEvidence(): EvidenceRecord {
    const registry = new VerifierRegistry();
    registry.register(
      createSchemaConformanceVerifier({
        id: "schema",
        version: "1.0.0",
        verifierRegistrationDigest: d("schema-registration"),
        rubricDigest: d("schema-rubric"),
        schema: z.object({ title: z.string(), citations: z.array(z.unknown()) }),
      }),
    );
    const artifact = artifactFor();
    const verification = registry.verify("schema", "1.0.0", artifact, content, {
      verifiedAt: "2026-08-03T12:01:00Z",
      verificationId: "verification-schema",
    });
    return buildEvidenceRecord({
      material: evidenceMaterial(),
      artifacts: [artifact],
      events: evidenceEvents(artifact, [verification]),
      verifications: [verification],
      verifierReferences: [verificationResultIdentity(verification)],
    });
  }

  it("builds referentially checked, deterministic JSON and Markdown evidence", () => {
    const evidence = deterministicEvidence();
    expect(verifyEvidenceDigest(evidence)).toBe(true);
    expect(exportEvidenceJson(evidence)).toBe(exportEvidenceJson(evidence));
    expect(exportEvidenceMarkdown(evidence)).toContain("## Does not prove");
    expect(exportEvidenceMarkdown(evidence)).toContain(evidence.evidenceDigest);
    expect(() =>
      buildEvidenceRecord({
        material: { ...evidenceMaterial(), tenantId: "other" },
        artifacts: [artifactFor()],
        events: [acceptedEvent()],
        verifications: [],
        verifierReferences: [],
      }),
    ).toThrow("KAF_EVIDENCE_INVALID_REFERENCE");
    const danglingRegistry = new VerifierRegistry();
    danglingRegistry.register(
      createArtifactIntegrityVerifier({
        id: "integrity",
        version: "1.0.0",
        verifierRegistrationDigest: d("integrity-registration"),
        rubricDigest: d("integrity-rubric"),
      }),
    );
    const originalArtifact = artifactFor();
    const danglingVerification = danglingRegistry.verify(
      "integrity",
      "1.0.0",
      originalArtifact,
      content,
      {
        verifiedAt: "2026-08-03T12:01:00Z",
        verificationId: "verification-dangling",
      },
    );
    expect(() =>
      buildEvidenceRecord({
        material: evidenceMaterial(),
        artifacts: [artifactFor(new TextEncoder().encode("different"))],
        events: evidenceEvents(originalArtifact, [danglingVerification]),
        verifications: [danglingVerification],
        verifierReferences: [verificationResultIdentity(danglingVerification)],
      }),
    ).toThrow("KAF_EVIDENCE_INVALID_REFERENCE");
    expect(() =>
      buildEvidenceRecord({
        material: evidenceMaterial(),
        artifacts: [artifactFor()],
        events: [],
        verifications: [],
        verifierReferences: [],
      }),
    ).toThrow("KAF_EVIDENCE_INVALID_REFERENCE");
    expect(() =>
      buildEvidenceRecord({
        material: evidenceMaterial(),
        artifacts: [artifactFor()],
        events: [{ ...acceptedEvent(), tenantId: "other" }],
        verifications: [],
        verifierReferences: [],
      }),
    ).toThrow("KAF_EVIDENCE_INVALID_REFERENCE");
    const noVerification = buildEvidenceRecord({
      material: { ...evidenceMaterial(), evidenceRecordId: "evidence-empty" },
      artifacts: [artifactFor()],
      events: evidenceEvents(artifactFor(), [], []),
      verifications: [],
      verifierReferences: [],
    });
    expect(exportEvidenceMarkdown(noVerification)).toContain("| none | unknown | n/a |");
  });

  it("does not permit model-only high-risk completion", () => {
    const registry = new VerifierRegistry();
    registry.register(
      createModelAssessmentVerifier({
        id: "model-review",
        version: "1.0.0",
        verifierRegistrationDigest: d("model-registration"),
        rubricVersion: "1",
        rubricDigest: d("model-rubric"),
        assess: () => [],
      }),
    );
    const artifact = artifactFor();
    const verification = registry.verify("model-review", "1.0.0", artifact, content, {
      verifiedAt: "2026-08-03T12:01:00Z",
      verificationId: "verification-model",
    });
    expect(() =>
      buildEvidenceRecord({
        material: evidenceMaterial("high"),
        artifacts: [artifact],
        events: evidenceEvents(artifact, [verification], []),
        verifications: [verification],
        verifierReferences: [verificationResultIdentity(verification)],
      }),
    ).toThrow("KAF_VERIFICATION_REQUIRED");
    expect(() =>
      buildEvidenceRecord({
        material: evidenceMaterial("critical"),
        artifacts: [artifact],
        events: evidenceEvents(artifact, [verification], []),
        verifications: [verification],
        verifierReferences: [verificationResultIdentity(verification)],
      }),
    ).toThrow("KAF_VERIFICATION_REQUIRED");
  });

  it("redacts typed fields before serialization and uses regex only as a safety net", () => {
    expect(
      redactTypedFields(
        { profile: { email: "user@example.com", token: "secret" }, items: ["secret"] },
        [{ path: ["profile", "token"] }, { path: ["items", 0], replacement: "removed" }],
      ),
    ).toEqual({
      profile: { email: "user@example.com", token: "[REDACTED]" },
      items: ["removed"],
    });
    expect(redactCommonSensitiveText("user@example.com Bearer abc.def")).toBe(
      "[REDACTED_EMAIL] Bearer [REDACTED]",
    );
    expect(() => redactTypedFields({ safe: true }, [{ path: ["missing"] }])).toThrow(
      "KAF_REDACTION_PATH_MISSING",
    );
    expect(() => redactTypedFields({ safe: true }, [{ path: [] }])).toThrow(
      "KAF_REDACTION_ROOT_FORBIDDEN",
    );
    expect(() =>
      redactTypedFields({ nested: "not-an-object" }, [{ path: ["nested", "secret"] }]),
    ).toThrow("KAF_REDACTION_PATH_MISSING");
    expect(() =>
      redactTypedFields({ nested: "not-an-object" }, [{ path: ["nested", "deeper", "secret"] }]),
    ).toThrow("KAF_REDACTION_PATH_MISSING");
    expect(
      redactTypedFields({ items: [{ token: "secret" }] }, [{ path: ["items", 0, "token"] }]),
    ).toEqual({ items: [{ token: "[REDACTED]" }] });
    expect(() => redactTypedFields({ items: ["value"] }, [{ path: ["items", "zero"] }])).toThrow(
      "KAF_REDACTION_PATH_MISSING",
    );
  });

  it("requires two independent same-scale observations before repeated maturity", () => {
    const first = deterministicEvidence();
    const secondMaterial = {
      ...first,
      evidenceRecordId: "evidence-2",
      observation: {
        ...first.observation,
        independentObservationIds: ["observation-2"],
      },
    };
    const { evidenceDigest: _previousDigest, ...secondWithoutDigest } = secondMaterial;
    const second: EvidenceRecord = {
      ...secondWithoutDigest,
      evidenceDigest: d(secondWithoutDigest),
    };
    void _previousDigest;
    const pattern = PatternManifestSchema.parse({
      schemaVersion: "1",
      patternId: "research-brief",
      version: "1.0.0",
      patternDigest: d("pattern"),
      title: "Research brief",
      description: "Schema-verified brief",
      maturity: "peer_reviewed",
      scaleUnit: { roleFamily: "research", workflowId: "brief", riskClass: "low" },
      assetRefs: [{ kind: "agent", id: "evidence-agent", version: "1.0.0", digest: d("agent") }],
      evidenceRecordDigests: [first.evidenceDigest],
      independentObservationCount: 1,
      supportedClaims: ["Produces schema-valid briefs"],
      doesNotProve: ["Business impact"],
      createdAt: "2026-08-03T12:00:00Z",
      updatedAt: "2026-08-03T12:00:00Z",
    });
    expect(() => promotePattern(pattern, "repeated", [first], "2026-08-03T13:00:00Z")).toThrow();
    const repeated = promotePattern(pattern, "repeated", [first, second], "2026-08-03T13:00:00Z");
    expect(repeated.independentObservationCount).toBe(2);
    expect(repeated.maturity).toBe("repeated");
  });
});
