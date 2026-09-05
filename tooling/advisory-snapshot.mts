import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Bytes } from "./lib/release-integrity.mjs";

type JsonRecord = Record<string, unknown>;

export interface AdvisoryVerificationInput {
  readonly snapshotPath: string;
  readonly checksumPath: string;
  readonly lockfilePath: string;
  readonly now: Date;
}

export interface AdvisoryVerificationResult {
  readonly snapshotDigest: string;
  readonly lockfileDigest: string;
  readonly upstreamRetrievedAt: string;
  readonly advisoryCount: number;
}

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

function string(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function equalDigest(left: string, right: string, code: string): void {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length || !timingSafeEqual(leftBytes, rightBytes))
    throw new Error(code);
}

export function verifyAdvisorySnapshot(
  input: AdvisoryVerificationInput,
): AdvisoryVerificationResult {
  const snapshotBytes = readFileSync(input.snapshotPath);
  const snapshotDigest = sha256Bytes(snapshotBytes);
  const expectedChecksum = readFileSync(input.checksumPath, "utf8").trim();
  if (!/^sha256:[0-9a-f]{64}$/u.test(expectedChecksum))
    throw new Error("KAF_ADVISORY_CHECKSUM_FORMAT_INVALID");
  equalDigest(snapshotDigest, expectedChecksum, "KAF_ADVISORY_CHECKSUM_MISMATCH");
  const snapshot = record(
    JSON.parse(snapshotBytes.toString("utf8")) as unknown,
    "KAF_ADVISORY_SNAPSHOT_INVALID",
  );
  if (snapshot.schemaVersion !== "1") throw new Error("KAF_ADVISORY_SCHEMA_UNSUPPORTED");
  const source = record(snapshot.source, "KAF_ADVISORY_SOURCE_INVALID");
  if (
    source.kind !== "upstream-export" ||
    typeof source.url !== "string" ||
    typeof source.databaseVersion !== "string"
  ) {
    throw new Error("KAF_ADVISORY_SOURCE_UNVERIFIED");
  }
  const upstreamRetrievedAt = string(source.retrievedAt, "KAF_ADVISORY_TIMESTAMP_INVALID");
  const retrieved = new Date(upstreamRetrievedAt);
  if (!Number.isFinite(retrieved.valueOf()) || retrieved > input.now)
    throw new Error("KAF_ADVISORY_TIMESTAMP_INVALID");
  const lockfileDigest = sha256Bytes(readFileSync(input.lockfilePath));
  equalDigest(
    lockfileDigest,
    string(snapshot.lockfileDigest, "KAF_ADVISORY_LOCKFILE_DIGEST_INVALID"),
    "KAF_ADVISORY_LOCKFILE_MISMATCH",
  );
  if (!Array.isArray(snapshot.advisories)) throw new Error("KAF_ADVISORY_FINDINGS_INVALID");
  for (const value of snapshot.advisories) {
    const advisory = record(value, "KAF_ADVISORY_FINDING_INVALID");
    if (
      !["low", "moderate", "high", "critical"].includes(
        string(advisory.severity, "KAF_ADVISORY_SEVERITY_INVALID"),
      )
    ) {
      throw new Error("KAF_ADVISORY_SEVERITY_INVALID");
    }
    if (
      (advisory.severity === "high" || advisory.severity === "critical") &&
      advisory.acceptance === undefined
    ) {
      throw new Error("KAF_ADVISORY_BLOCKING_FINDING");
    }
    if (advisory.acceptance !== undefined) {
      const acceptance = record(advisory.acceptance, "KAF_ADVISORY_ACCEPTANCE_INVALID");
      if (
        acceptance.findingId !== advisory.id ||
        acceptance.package !== advisory.package ||
        acceptance.version !== advisory.version
      ) {
        throw new Error("KAF_ADVISORY_ACCEPTANCE_SCOPE_MISMATCH");
      }
      const expiresAt = new Date(string(acceptance.expiresAt, "KAF_ADVISORY_ACCEPTANCE_INVALID"));
      const issuedAt = new Date(string(acceptance.issuedAt, "KAF_ADVISORY_ACCEPTANCE_INVALID"));
      if (!Number.isFinite(expiresAt.valueOf()) || !Number.isFinite(issuedAt.valueOf()))
        throw new Error("KAF_ADVISORY_ACCEPTANCE_INVALID");
      if (expiresAt <= input.now || expiresAt.valueOf() - issuedAt.valueOf() > 30 * 86_400_000) {
        throw new Error("KAF_ADVISORY_ACCEPTANCE_EXPIRED");
      }
      for (const field of ["owner", "justification", "scope", "compensatingControls"] as const) {
        string(acceptance[field], "KAF_ADVISORY_ACCEPTANCE_INVALID");
      }
    }
  }
  const { canonicalDigest: claimedCanonicalDigest, ...canonicalMaterial } = snapshot;
  const canonicalDigest = `sha256:${createHash("sha256").update(canonicalJson(canonicalMaterial)).digest("hex")}`;
  if (claimedCanonicalDigest !== canonicalDigest)
    throw new Error("KAF_ADVISORY_CANONICAL_DIGEST_MISMATCH");
  return {
    snapshotDigest,
    lockfileDigest,
    upstreamRetrievedAt,
    advisoryCount: snapshot.advisories.length,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [snapshotPath, checksumPath, lockfilePath] = process.argv.slice(2);
  if (snapshotPath === undefined || checksumPath === undefined || lockfilePath === undefined) {
    throw new Error("Usage: advisory-snapshot.mts <snapshot> <checksum> <lockfile>");
  }
  const result = verifyAdvisorySnapshot({
    snapshotPath,
    checksumPath,
    lockfilePath,
    now: new Date(),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
