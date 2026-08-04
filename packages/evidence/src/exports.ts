import {
  EvidenceRecordSchema,
  JsonValueSchema,
  canonicalJsonStringify,
  digestCanonicalJson,
  type EvidenceRecord,
  type JsonValue,
} from "@pactmark/core";

import { exportEvidenceMarkdown, verifyEvidenceDigest } from "./records.js";
import { redactTypedFields, type RedactionRule } from "./redaction.js";

export interface EvidenceExport {
  readonly schemaVersion: "1";
  readonly sourceEvidenceDigest: string;
  readonly evidence: EvidenceRecord;
  readonly redactedPaths: readonly string[];
  readonly exportDigest: string;
}

function redactionPath(rule: RedactionRule): string {
  return rule.path.map(String).join(".");
}

function assertExportRedactionPath(rule: RedactionRule): void {
  const [root, second] = rule.path;
  const allowed =
    (root === "reviewer" && (second === "reviewerId" || second === "conflictDetails")) ||
    (root === "claim" && (second === "statement" || second === "scope")) ||
    ((root === "supports" || root === "doesNotProve") && typeof second === "number") ||
    (root === "workSplit" && second === "description");
  if (!allowed || rule.path.length !== 2) {
    throw new TypeError("KAF_EVIDENCE_REDACTION_PATH_FORBIDDEN");
  }
}

export function createEvidenceExport(
  recordValue: EvidenceRecord,
  rules: readonly RedactionRule[],
): EvidenceExport {
  const source = EvidenceRecordSchema.parse(recordValue);
  if (!verifyEvidenceDigest(source)) throw new TypeError("KAF_EVIDENCE_DIGEST_INVALID");
  for (const rule of rules) assertExportRedactionPath(rule);
  const sourceJson = JsonValueSchema.parse(JSON.parse(canonicalJsonStringify(source)));
  const redactedJson = redactTypedFields(sourceJson, rules);
  if (typeof redactedJson !== "object" || redactedJson === null || Array.isArray(redactedJson)) {
    throw new TypeError("KAF_EVIDENCE_REDACTION_INVALID");
  }
  const redactedObject = redactedJson as Readonly<Record<string, JsonValue>>;
  const { evidenceDigest: _sourceDigest, ...redactedMaterial } = redactedObject;
  const evidence = EvidenceRecordSchema.parse({
    ...redactedMaterial,
    evidenceDigest: digestCanonicalJson(redactedMaterial),
  });
  void _sourceDigest;
  const material = {
    schemaVersion: "1" as const,
    sourceEvidenceDigest: source.evidenceDigest,
    evidence,
    redactedPaths: rules.map(redactionPath).sort(),
  };
  return Object.freeze({ ...material, exportDigest: digestCanonicalJson(material) });
}

export function verifyEvidenceExportDigest(exportValue: EvidenceExport): boolean {
  const { exportDigest, ...material } = exportValue;
  return (
    exportDigest === digestCanonicalJson(material) &&
    verifyEvidenceDigest(EvidenceRecordSchema.parse(exportValue.evidence))
  );
}

export function exportRedactedEvidenceJson(
  record: EvidenceRecord,
  rules: readonly RedactionRule[],
): string {
  return `${canonicalJsonStringify(createEvidenceExport(record, rules))}\n`;
}

export function exportRedactedEvidenceMarkdown(
  record: EvidenceRecord,
  rules: readonly RedactionRule[],
): string {
  const exported = createEvidenceExport(record, rules);
  return [
    `<!-- source-evidence-digest: ${exported.sourceEvidenceDigest} -->`,
    `<!-- export-digest: ${exported.exportDigest} -->`,
    exportEvidenceMarkdown(exported.evidence),
  ].join("\n");
}
