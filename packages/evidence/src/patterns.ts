import {
  EvidenceRecordSchema,
  PatternManifestSchema,
  assertPatternPromotion,
  digestCanonicalJson,
  type EvidenceRecord,
  type PatternManifest,
  type PatternMaturity,
} from "@pactmark/core";

function sameScale(pattern: PatternManifest, evidence: EvidenceRecord): boolean {
  return (
    evidence.context.roleFamily === pattern.scaleUnit.roleFamily &&
    evidence.context.workflowId === pattern.scaleUnit.workflowId &&
    evidence.context.riskClass === pattern.scaleUnit.riskClass
  );
}

export function promotePattern(
  patternValue: PatternManifest,
  target: PatternMaturity,
  evidenceRecords: readonly EvidenceRecord[],
  updatedAt: string,
): PatternManifest {
  const pattern = PatternManifestSchema.parse(patternValue);
  const records = evidenceRecords.map((evidence) => {
    const record = EvidenceRecordSchema.parse(evidence);
    const { evidenceDigest, ...material } = record;
    if (evidenceDigest !== digestCanonicalJson(material)) {
      throw new TypeError("KAF_EVIDENCE_DIGEST_INVALID");
    }
    return record;
  });
  const matching = records.filter((evidence) => sameScale(pattern, evidence));
  const independent = new Set(
    matching.flatMap((evidence) => evidence.observation.independentObservationIds),
  );
  const eligible = PatternManifestSchema.parse({
    ...pattern,
    evidenceRecordDigests: [...new Set(matching.map((evidence) => evidence.evidenceDigest))].sort(),
    independentObservationCount: independent.size,
    updatedAt,
  });
  assertPatternPromotion(eligible, target);
  if (
    target === "proven" &&
    (eligible.baseline === undefined ||
      !eligible.evidenceRecordDigests.includes(eligible.baseline.advantageEvidenceDigest))
  ) {
    throw new TypeError("KAF_PATTERN_INSUFFICIENT_EVIDENCE");
  }
  const material = { ...eligible, maturity: target };
  const { patternDigest: _previousDigest, ...digestMaterial } = material;
  const candidate = PatternManifestSchema.parse({
    ...material,
    patternDigest: digestCanonicalJson(digestMaterial),
  });
  void _previousDigest;
  return candidate;
}
