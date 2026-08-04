import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { canonicalJson, sha256Bytes } from "./lib/release-integrity.mjs";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

function string(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

const [auditPath, lockfilePath, snapshotPath, checksumPath, retrievedAtInput] =
  process.argv.slice(2);
if (
  auditPath === undefined ||
  lockfilePath === undefined ||
  snapshotPath === undefined ||
  checksumPath === undefined
) {
  throw new Error(
    "Usage: create-advisory-snapshot.mts <audit.json> <lockfile> <snapshot.json> <snapshot.sha256> [retrievedAt]",
  );
}
const audit = record(
  JSON.parse(readFileSync(auditPath, "utf8")) as unknown,
  "KAF_ADVISORY_UPSTREAM_EXPORT_INVALID",
);
const reportVersion =
  audit["auditReportVersion"] === undefined && audit["advisories"] !== undefined
    ? "pnpm-v11"
    : string(audit["auditReportVersion"], "unknown");
if (reportVersion === "unknown") {
  throw new Error("KAF_ADVISORY_UPSTREAM_EXPORT_INVALID");
}
const vulnerabilities = record(
  audit["vulnerabilities"] ?? audit["advisories"] ?? {},
  "KAF_ADVISORY_UPSTREAM_EXPORT_INVALID",
);
const advisories = Object.entries(vulnerabilities)
  .flatMap(([packageName, value]) => {
    const vulnerability = record(value, "KAF_ADVISORY_UPSTREAM_EXPORT_INVALID");
    const severity = vulnerability["severity"];
    if (!["low", "moderate", "high", "critical"].includes(String(severity))) return [];
    const via = Array.isArray(vulnerability["via"]) ? vulnerability["via"] : [];
    const records = via.filter(
      (entry): entry is JsonRecord =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    );
    if (records.length === 0) {
      return [
        {
          id: `${packageName}:${string(vulnerability["range"] ?? vulnerability["vulnerable_versions"], "unknown")}`,
          package: string(vulnerability["module_name"], packageName),
          version: string(
            vulnerability["range"] ?? vulnerability["vulnerable_versions"],
            "unknown",
          ),
          severity: String(severity),
          title: "Transitive advisory reported by npm audit",
          sourceUrl: "https://registry.npmjs.org/-/npm/v1/security/audits",
        },
      ];
    }
    return records.map((entry) => ({
      id: string(entry["source"], string(entry["url"], `${packageName}:unknown`)),
      package: packageName,
      version: string(vulnerability["range"], "unknown"),
      severity: String(entry["severity"] ?? severity),
      title: string(entry["title"], "npm security advisory"),
      sourceUrl: string(entry["url"], "https://registry.npmjs.org/-/npm/v1/security/audits"),
    }));
  })
  .sort((left, right) =>
    `${left.package}:${left.id}`.localeCompare(`${right.package}:${right.id}`),
  );
const retrievedAt = new Date(retrievedAtInput ?? Date.now()).toISOString();
const material: JsonRecord = {
  schemaVersion: "1",
  source: {
    kind: "upstream-export",
    url: "https://registry.npmjs.org/-/npm/v1/security/audits",
    databaseVersion: `npm-audit-report-${reportVersion}`,
    retrievedAt,
  },
  lockfileDigest: sha256Bytes(readFileSync(lockfilePath)),
  advisories,
};
material["canonicalDigest"] =
  `sha256:${createHash("sha256").update(canonicalJson(material)).digest("hex")}`;
mkdirSync(dirname(snapshotPath), { recursive: true });
mkdirSync(dirname(checksumPath), { recursive: true });
writeFileSync(snapshotPath, `${JSON.stringify(material, null, 2)}\n`, { mode: 0o600 });
writeFileSync(checksumPath, `${sha256Bytes(readFileSync(snapshotPath))}\n`, { mode: 0o600 });
process.stdout.write(
  `${JSON.stringify({ snapshotPath, advisoryCount: advisories.length, retrievedAt })}\n`,
);
