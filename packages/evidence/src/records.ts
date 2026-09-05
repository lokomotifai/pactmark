import {
  ApprovalSchema,
  ArtifactSchema,
  EvidenceRecordSchema,
  RunEventSchema,
  VerificationExceptionSchema,
  VerificationResultSchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  type Approval,
  type Artifact,
  type EvidenceRecord,
  type RunEvent,
  type VerificationException,
  type VerificationResult,
} from "@pactmark/core";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import { verifyVerificationExceptionDigest } from "./exceptions.js";
import type { VerifierReferenceIdentity } from "./verifiers.js";

function verifierKey(reference: VerifierReferenceIdentity): string {
  return canonicalJsonStringify([
    reference.id,
    reference.version,
    reference.verifierRegistrationDigest,
    reference.rubricVersion,
    reference.rubricDigest,
  ]);
}

export type EvidenceMaterial = Omit<
  EvidenceRecord,
  | "evidenceDigest"
  | "artifactRefs"
  | "eventRefs"
  | "approvalRefs"
  | "verificationRefs"
  | "verificationExceptionRefs"
>;

export interface BuildEvidenceInput {
  readonly material: EvidenceMaterial;
  readonly artifacts: readonly Artifact[];
  readonly events: readonly RunEvent[];
  readonly approvals?: readonly Approval[];
  readonly verifications: readonly VerificationResult[];
  readonly verificationExceptions?: readonly VerificationException[];
  readonly verifierReferences: readonly VerifierReferenceIdentity[];
}

export function buildEvidenceRecord(input: BuildEvidenceInput): EvidenceRecord {
  if (input.events.length === 0) throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
  const artifacts = input.artifacts.map((artifact) => ArtifactSchema.parse(artifact));
  const events = input.events.map((event) => RunEventSchema.parse(event));
  const approvals = (input.approvals ?? []).map((approval) => ApprovalSchema.parse(approval));
  const verifications = input.verifications.map((verification) =>
    VerificationResultSchema.parse(verification),
  );
  const verificationExceptions = (input.verificationExceptions ?? []).map((exception) =>
    VerificationExceptionSchema.parse(exception),
  );
  if (
    new Set(artifacts.map((artifact) => artifact.artifactId)).size !== artifacts.length ||
    new Set(approvals.map((approval) => approval.id)).size !== approvals.length ||
    new Set(verifications.map((verification) => verification.verificationId)).size !==
      verifications.length ||
    new Set(verificationExceptions.map((exception) => exception.exceptionId)).size !==
      verificationExceptions.length
  ) {
    throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
  }
  const eventIds = new Set(events.map((event) => event.eventId));
  const eventSequences = new Set(events.map((event) => event.sequence));
  if (eventIds.size !== events.length || eventSequences.size !== events.length) {
    throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
  }
  for (const event of events) {
    if (
      event.tenantId !== input.material.tenantId ||
      event.runId !== input.material.runId ||
      event.executionDefinitionDigest !== input.material.executionDefinitionDigest ||
      digestCanonicalJson(event.executionDefinition) !== input.material.executionDefinitionDigest
    ) {
      throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
    }
    if (
      event.eventType === "RunAccepted" &&
      event.payload.workOrderBindingDigest !== input.material.workOrderBindingDigest
    ) {
      throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
    }
  }
  if (
    digestCanonicalJson(input.material.executionDefinition) !==
    input.material.executionDefinitionDigest
  ) {
    throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
  }
  for (const artifact of artifacts) {
    const { artifactDigest, ...artifactMaterial } = artifact;
    if (
      artifact.tenantId !== input.material.tenantId ||
      artifact.producingRunId !== input.material.runId ||
      artifactDigest !== digestCanonicalJson(artifactMaterial) ||
      digestCanonicalJson(artifact.provenance.executionDefinition) !==
        input.material.executionDefinitionDigest ||
      artifact.provenance.executionDefinitionDigest !== input.material.executionDefinitionDigest ||
      artifact.provenance.workOrderBindingDigest !== input.material.workOrderBindingDigest ||
      !events.some(
        (event) =>
          event.eventId === artifact.provenance.producingEventId &&
          event.eventType === "ArtifactProduced" &&
          event.payload.stepId === artifact.producingStepId &&
          event.payload.artifactId === artifact.artifactId &&
          event.payload.artifactDigest === artifact.artifactDigest,
      )
    ) {
      throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
    }
  }
  for (const approval of approvals) {
    if (
      approval.binding.tenant.id !== input.material.tenantId ||
      approval.binding.runId !== input.material.runId ||
      approval.binding.purpose.code !== input.material.permission.purposeCode ||
      approval.binding.purpose.registryVersion !==
        input.material.permission.purposeRegistryVersion ||
      Date.parse(approval.createdAt) > Date.parse(input.material.createdAt) ||
      Date.parse(approval.expiresAt) <= Date.parse(input.material.createdAt) ||
      digestCanonicalJson(approval.binding.executionDefinition) !==
        input.material.executionDefinitionDigest ||
      approval.binding.executionDefinitionDigest !== input.material.executionDefinitionDigest ||
      approval.binding.workOrderBindingDigest !== input.material.workOrderBindingDigest ||
      !events.some(
        (event) =>
          event.eventType === "ApprovalRecorded" &&
          event.payload.stepId === approval.binding.stepId &&
          event.payload.approvalId === approval.id &&
          event.payload.decisionId === approval.binding.decisionId,
      )
    ) {
      throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
    }
  }
  const verifierKeys = new Set(input.verifierReferences.map((reference) => verifierKey(reference)));
  if (verifierKeys.size !== input.verifierReferences.length) {
    throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
  }
  const usedVerifierKeys = new Set<string>();
  for (const verification of verifications) {
    const { verificationDigest, ...verificationMaterial } = verification;
    const verifiedArtifact = artifacts.find(
      (artifact) => artifact.artifactDigest === verification.artifactDigest,
    );
    const key = verifierKey({
      id: verification.verifierId,
      version: verification.verifierVersion,
      verifierRegistrationDigest: verification.verifierRegistrationDigest,
      rubricVersion: verification.rubricVersion,
      rubricDigest: verification.rubricDigest,
    });
    if (
      verifiedArtifact === undefined ||
      verificationDigest !== digestCanonicalJson(verificationMaterial) ||
      !verifierKeys.has(key) ||
      !events.some(
        (event) =>
          event.eventType === "VerificationRecorded" &&
          event.payload.stepId === verifiedArtifact.producingStepId &&
          event.payload.verificationId === verification.verificationId &&
          event.payload.verifierId === verification.verifierId &&
          event.payload.status === verification.status &&
          event.payload.verificationDigest === verification.verificationDigest,
      )
    ) {
      throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
    }
    usedVerifierKeys.add(key);
  }
  for (const exception of verificationExceptions) {
    const exceptedArtifact = artifacts.find(
      (artifact) => artifact.artifactDigest === exception.artifactDigest,
    );
    const verifierReference = input.verifierReferences.find(
      (reference) =>
        reference.id === exception.verifierId &&
        reference.verifierRegistrationDigest === exception.verifierRegistrationDigest &&
        reference.rubricVersion === exception.rubricVersion &&
        reference.rubricDigest === exception.rubricDigest,
    );
    const key = verifierReference === undefined ? undefined : verifierKey(verifierReference);
    if (
      exception.tenantId !== input.material.tenantId ||
      exception.runId !== input.material.runId ||
      exceptedArtifact === undefined ||
      !verifyVerificationExceptionDigest(exception) ||
      Date.parse(exception.issuedAt) > Date.parse(input.material.createdAt) ||
      Date.parse(exception.expiresAt) <= Date.parse(input.material.createdAt) ||
      verifications.some(
        (verification) =>
          verification.artifactDigest === exception.artifactDigest &&
          verification.verifierId === exception.verifierId &&
          verification.verifierRegistrationDigest === exception.verifierRegistrationDigest,
      ) ||
      !input.material.supports.some((support) => support.includes(exception.exceptionId)) ||
      !input.material.doesNotProve.some((limit) => limit.includes(exception.exceptionId)) ||
      key === undefined ||
      !events.some(
        (event) =>
          event.eventType === "VerificationExceptionRecorded" &&
          event.payload.stepId === exceptedArtifact.producingStepId &&
          event.payload.exceptionId === exception.exceptionId &&
          event.payload.exceptionDigest === exception.exceptionDigest &&
          event.payload.verifierId === exception.verifierId &&
          event.payload.verifierRegistrationDigest === exception.verifierRegistrationDigest &&
          event.payload.artifactDigest === exception.artifactDigest &&
          event.payload.rubricVersion === exception.rubricVersion &&
          event.payload.rubricDigest === exception.rubricDigest &&
          event.payload.reviewerRole === exception.reviewer.role &&
          event.payload.expiresAt === exception.expiresAt &&
          event.payload.reason === exception.reason &&
          digestCanonicalJson(event.payload.compensatingControls) ===
            digestCanonicalJson(exception.compensatingControls),
      )
    ) {
      throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
    }
    usedVerifierKeys.add(key);
  }
  if (usedVerifierKeys.size !== verifierKeys.size) {
    throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
  }
  const acceptedEvents = events.filter((event) => event.eventType === "RunAccepted");
  const accepted = acceptedEvents[0];
  if (accepted === undefined || acceptedEvents.length !== 1) {
    throw new TypeError("KAF_EVIDENCE_INVALID_REFERENCE");
  }
  for (const requiredVerifierId of accepted.payload.requiredVerifierIds) {
    const failed = verifications.some(
      (verification) =>
        verification.status === "fail" &&
        (verification.verifierId === requiredVerifierId ||
          verification.verifierRegistrationDigest === requiredVerifierId),
    );
    const passed = verifications.some(
      (verification) =>
        verification.status === "pass" &&
        (verification.verifierId === requiredVerifierId ||
          verification.verifierRegistrationDigest === requiredVerifierId),
    );
    const excepted = verificationExceptions.some(
      (exception) =>
        exception.verifierId === requiredVerifierId ||
        exception.verifierRegistrationDigest === requiredVerifierId,
    );
    if (failed || (!passed && !excepted)) throw new TypeError("KAF_VERIFICATION_REQUIRED");
  }
  const highRisk =
    input.material.context.riskClass === "high" || input.material.context.riskClass === "critical";
  if (
    highRisk &&
    !verifications.some(
      (verification) =>
        verification.status === "pass" &&
        (verification.method === "deterministic" || verification.method === "human"),
    )
  ) {
    throw new TypeError("KAF_VERIFICATION_REQUIRED");
  }
  const recordWithoutDigest = {
    ...input.material,
    artifactRefs: artifacts
      .map(({ artifactId, artifactDigest }) => ({ artifactId, artifactDigest }))
      .sort((left, right) => compareCodeUnits(left.artifactId, right.artifactId)),
    eventRefs: events
      .map(({ eventId, sequence }) => ({ eventId, sequence }))
      .sort((left, right) => left.sequence - right.sequence),
    approvalRefs: approvals
      .map((approval) => ({
        approvalId: approval.id,
        approvalDigest: digestCanonicalJson(approval.binding),
      }))
      .sort((left, right) => compareCodeUnits(left.approvalId, right.approvalId)),
    verificationRefs: verifications
      .map(
        ({
          verificationId,
          verificationDigest,
          status,
          artifactDigest,
          verifierId,
          verifierVersion,
          verifierRegistrationDigest,
          method,
          rubricVersion,
          rubricDigest,
        }) => ({
          verificationId,
          verificationDigest,
          status,
          artifactDigest,
          verifierId,
          verifierVersion,
          verifierRegistrationDigest,
          method,
          rubricVersion,
          rubricDigest,
        }),
      )
      .sort((left, right) => compareCodeUnits(left.verificationId, right.verificationId)),
    verificationExceptionRefs: verificationExceptions
      .map(
        ({
          exceptionId,
          exceptionDigest,
          verifierId,
          verifierRegistrationDigest,
          artifactDigest,
          rubricVersion,
          rubricDigest,
        }) => ({
          exceptionId,
          exceptionDigest,
          verifierId,
          verifierRegistrationDigest,
          artifactDigest,
          rubricVersion,
          rubricDigest,
        }),
      )
      .sort((left, right) => compareCodeUnits(left.exceptionId, right.exceptionId)),
  };
  return EvidenceRecordSchema.parse({
    ...recordWithoutDigest,
    evidenceDigest: digestCanonicalJson(recordWithoutDigest),
  });
}

export function exportEvidenceJson(record: EvidenceRecord): string {
  return `${canonicalJsonStringify(EvidenceRecordSchema.parse(record))}\n`;
}

function markdownText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function exportEvidenceMarkdown(recordValue: EvidenceRecord): string {
  const record = EvidenceRecordSchema.parse(recordValue);
  const supports = record.supports.map((item) => `- ${markdownText(item)}`).join("\n");
  const limits = record.doesNotProve.map((item) => `- ${markdownText(item)}`).join("\n");
  const verifications = record.verificationRefs
    .map(
      (item) =>
        `| ${markdownText(item.verificationId)} | ${item.status} | ${item.verificationDigest} |`,
    )
    .join("\n");
  return [
    `# Evidence: ${markdownText(record.claim.statement)}`,
    "",
    `- Evidence ID: \`${record.evidenceRecordId}\``,
    `- Digest: \`${record.evidenceDigest}\``,
    `- Run: \`${record.runId}\``,
    `- Scope: ${markdownText(record.claim.scope)}`,
    `- Observed: ${record.freshness.observedAt}`,
    `- Valid at: ${record.freshness.validAt}`,
    "",
    "## Supports",
    "",
    supports,
    "",
    "## Does not prove",
    "",
    limits,
    "",
    "## Verification references",
    "",
    "| Verification | Status | Digest |",
    "| --- | --- | --- |",
    verifications || "| none | unknown | n/a |",
    "",
  ].join("\n");
}

export function verifyEvidenceDigest(recordValue: EvidenceRecord): boolean {
  const record = EvidenceRecordSchema.parse(recordValue);
  const { evidenceDigest, ...material } = record;
  return evidenceDigest === digestCanonicalJson(material);
}
