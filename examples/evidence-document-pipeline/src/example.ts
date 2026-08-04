import { RunEventSchema, digestCanonicalJson } from "@pactmark/core";
import {
  VerifierRegistry,
  buildEvidenceRecord,
  createArtifactIntegrityVerifier,
  createCitationShapeVerifier,
  exportEvidenceJson,
  exportEvidenceMarkdown,
  verificationResultIdentity,
  verifyEvidenceDigest,
} from "@pactmark/evidence";
import {
  CONTRACT_EXECUTION_DEFINITION,
  CONTRACT_EXECUTION_DEFINITION_DIGEST,
  CONTRACT_INSTANT,
  contractDigest,
  createContractArtifact,
  createContractRunAcceptedEvent,
  createContractWorkOrder,
} from "@pactmark/testing";

export function runEvidenceDocumentPipeline() {
  const content = new TextEncoder().encode(
    JSON.stringify({
      title: "Bounded fixture brief",
      body: "This statement is supported only by the embedded fixture.",
      citations: [{ title: "Fixture source", url: "https://example.invalid/source" }],
    }),
  );
  const { artifact, content: storedContent } = createContractArtifact(content);
  const registry = new VerifierRegistry();
  registry.register(
    createArtifactIntegrityVerifier({
      id: "integrity",
      version: "1",
      verifierRegistrationDigest: contractDigest("integrity-registration"),
      rubricDigest: contractDigest("integrity-rubric"),
    }),
  );
  registry.register(
    createCitationShapeVerifier({
      id: "citations",
      version: "1",
      verifierRegistrationDigest: contractDigest("citation-registration"),
      rubricDigest: contractDigest("citation-rubric"),
    }),
  );
  const integrity = registry.verify("integrity", "1", artifact, storedContent, {
    verifiedAt: CONTRACT_INSTANT,
    verificationId: "integrity-result",
  });
  const citations = registry.verify("citations", "1", artifact, storedContent, {
    verifiedAt: CONTRACT_INSTANT,
    verificationId: "citation-result",
  });
  const event = createContractRunAcceptedEvent();
  const artifactEvent = RunEventSchema.parse({
    ...event,
    eventId: artifact.provenance.producingEventId,
    sequence: 2,
    eventType: "ArtifactProduced",
    payload: {
      stepId: artifact.producingStepId,
      artifactId: artifact.artifactId,
      artifactDigest: artifact.artifactDigest,
    },
  });
  const verificationEvents = [integrity, citations].map((verification, index) =>
    RunEventSchema.parse({
      ...event,
      eventId: `contract-verification-event-${String(index + 1)}`,
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
  );
  const workOrder = createContractWorkOrder();
  const evidence = buildEvidenceRecord({
    material: {
      schemaVersion: "1",
      evidenceRecordId: "document-evidence",
      tenantId: "contract-tenant",
      runId: "contract-run",
      executionDefinition: CONTRACT_EXECUTION_DEFINITION,
      executionDefinitionDigest: CONTRACT_EXECUTION_DEFINITION_DIGEST,
      workOrderBindingDigest: workOrder.workOrderBindingDigest,
      claim: {
        statement: "The exact fixture document passed integrity and citation-shape checks.",
        claimType: "technical_verification",
        scope: "one fixture artifact",
      },
      supports: [
        "Exact bytes matched the artifact digest.",
        "The document contained a title and HTTPS citation URL.",
      ],
      doesNotProve: [
        "The cited URL exists or supports the document's claim.",
        "The document is factually complete.",
      ],
      context: {
        roleFamily: "research",
        workflowId: "fixture-document",
        riskClass: "low",
        purposeCode: "testing",
      },
      workSplit: {
        ai: { kind: "unavailable", reason: "not_applicable" },
        human: { kind: "unavailable", reason: "not_collected" },
        description: "Deterministic fixture verification only.",
      },
      permission: {
        purposeCode: "testing",
        purposeRegistryVersion: "1",
        visibility: "tenant",
        dataClass: "internal",
        retention: { mode: "session" },
      },
      freshness: { observedAt: CONTRACT_INSTANT, validAt: CONTRACT_INSTANT },
      observation: {
        firstObservedAt: CONTRACT_INSTANT,
        lastObservedAt: CONTRACT_INSTANT,
        count: 1,
        repetitionStatus: "single",
        independentObservationIds: [],
      },
      createdAt: CONTRACT_INSTANT,
    },
    artifacts: [artifact],
    events: [event, artifactEvent, ...verificationEvents],
    verifications: [integrity, citations],
    verifierReferences: [integrity, citations].map(verificationResultIdentity),
  });
  return Object.freeze({
    artifact,
    integrity,
    citations,
    evidence,
    json: exportEvidenceJson(evidence),
    markdown: exportEvidenceMarkdown(evidence),
    digestValid: verifyEvidenceDigest(evidence),
    pipelineDigest: digestCanonicalJson({
      artifact: artifact.artifactDigest,
      evidence: evidence.evidenceDigest,
    }),
  });
}
