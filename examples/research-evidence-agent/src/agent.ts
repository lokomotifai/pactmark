import { RunEventSchema, digestCanonicalJson, type Digest } from "@pactmark/core";
import {
  VerifierRegistry,
  buildEvidenceRecord,
  createArtifact,
  exportEvidenceJson,
  exportEvidenceMarkdown,
  verificationResultIdentity,
  verifyEvidenceDigest,
} from "@pactmark/evidence";
import type { ResearchDocument } from "./contract.js";
import { researchPolicy } from "./policy.js";
import { searchFixture } from "./tools/fixture-search.js";
import { citationVerifier, integrityVerifier } from "./verifiers/citations.js";

const instant = "2026-01-01T00:00:00.000Z";
const executionDefinition = Object.freeze({
  kind: "agent" as const,
  id: "research-evidence-agent",
  version: "0.1.0",
  agentDefinitionDigest: digestCanonicalJson({ agent: "research-evidence-agent@0.1.0" }),
});
const executionDefinitionDigest = digestCanonicalJson(executionDefinition);
const workOrderBindingDigest = digestCanonicalJson({ workOrder: "research-fixture@1" });

export function runResearchEvidence(query = "deterministic offline verification") {
  if (!researchPolicy.tools.includes("fixture.search@1")) {
    throw new TypeError("KAF_RESEARCH_TOOL_DENIED");
  }
  const sources = searchFixture(query);
  if (sources.length === 0) throw new TypeError("KAF_RESEARCH_NO_FIXTURE_RESULT");
  const document: ResearchDocument = Object.freeze({
    title: "Deterministic fixture research brief",
    body: "The embedded fixture states that offline verification is supported.",
    citations: Object.freeze(sources.map(({ title, url }) => Object.freeze({ title, url }))),
    sourceDates: Object.freeze(
      sources.map(({ id: sourceId, publishedAt, observedAt }) =>
        Object.freeze({ sourceId, publishedAt, observedAt }),
      ),
    ),
    observedSupport: Object.freeze(sources.map((source) => source.body)),
    inferences: Object.freeze([
      "The fixture is suitable for this repository's offline scenario test.",
    ]),
  });
  const content = new TextEncoder().encode(JSON.stringify(document));
  const artifact = createArtifact(
    {
      schemaVersion: "1",
      artifactId: "research-brief",
      mediaType: "application/json",
      location: { kind: "inline", encoding: "base64", content: bytesToBase64(content) },
      tenantId: "example-tenant",
      producingRunId: "research-run",
      producingStepId: "research-step",
      owner: { type: "tenant", id: "example-tenant" },
      visibility: "tenant",
      dataClass: "public",
      purposeCode: "research",
      retention: { mode: "session" },
      provenance: {
        schemaVersion: "1",
        executionDefinition,
        executionDefinitionDigest,
        workOrderBindingDigest,
        producingEventId: "research-artifact-created",
        sourceArtifactDigests: [] as Digest[],
        toolRegistrationDigests: [digestCanonicalJson({ tool: "fixture.search@1" })],
        metadata: { sourceObservedAt: instant },
      },
      createdAt: instant,
    },
    content,
  );
  const registry = new VerifierRegistry();
  registry.register(integrityVerifier);
  registry.register(citationVerifier);
  const integrity = registry.verify("research.integrity", "1", artifact, content, {
    verifiedAt: instant,
    verificationId: "research-integrity-result",
  });
  const citations = registry.verify("research.citations", "1", artifact, content, {
    verifiedAt: instant,
    verificationId: "research-citation-result",
  });
  const event = RunEventSchema.parse({
    schemaVersion: "1",
    eventId: "research-event-1",
    eventType: "RunAccepted",
    runId: "research-run",
    sequence: 1,
    occurredAt: instant,
    correlationId: "research-correlation",
    tenantId: "example-tenant",
    dataClass: "public",
    executionDefinition,
    executionDefinitionDigest,
    payload: {
      workOrderId: "research-work-order",
      workOrderBindingDigest,
      requiredVerifierIds: ["research.integrity", "research.citations"],
    },
  });
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
      eventId: `research-verification-event-${String(index + 1)}`,
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
  const evidence = buildEvidenceRecord({
    material: {
      schemaVersion: "1",
      evidenceRecordId: "research-evidence",
      tenantId: "example-tenant",
      runId: "research-run",
      executionDefinition,
      executionDefinitionDigest,
      workOrderBindingDigest,
      claim: {
        statement: "The embedded fixture supports deterministic offline verification.",
        claimType: "source_support",
        scope: "one immutable repository fixture",
      },
      supports: [
        "The exact fixture bytes passed integrity verification.",
        "The fixture explicitly states support for deterministic offline verification.",
      ],
      doesNotProve: [
        "The cited URL exists or is authoritative.",
        "The inference generalizes beyond the embedded fixture.",
        "The brief is complete.",
      ],
      context: {
        roleFamily: "research",
        workflowId: "fixture-research",
        riskClass: "low",
        purposeCode: "research",
      },
      workSplit: {
        ai: { kind: "unavailable", reason: "not_applicable" },
        human: { kind: "unavailable", reason: "not_collected" },
        description: "Deterministic fixture transformation only.",
      },
      permission: {
        purposeCode: "research",
        purposeRegistryVersion: "1",
        visibility: "tenant",
        dataClass: "public",
        retention: { mode: "session" },
      },
      freshness: { observedAt: instant, validAt: instant },
      observation: {
        firstObservedAt: instant,
        lastObservedAt: instant,
        count: 1,
        repetitionStatus: "single",
        independentObservationIds: [],
      },
      createdAt: instant,
    },
    artifacts: [artifact],
    events: [event, artifactEvent, ...verificationEvents],
    verifications: [integrity, citations],
    verifierReferences: [integrity, citations].map(verificationResultIdentity),
  });
  return Object.freeze({
    document,
    artifact,
    integrity,
    citations,
    evidence,
    digestValid: verifyEvidenceDigest(evidence),
    json: exportEvidenceJson(evidence),
    markdown: exportEvidenceMarkdown(evidence),
  });
}
function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
