import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readJson, repositoryRoot } from "./lib/repository.mjs";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

export interface CoordinatedReleaseMetadata {
  readonly version: string;
  readonly packageNames: readonly string[];
}

/** Derives the coordinated public release identity from checked-in package manifests. */
export function coordinatedReleaseMetadata(root = repositoryRoot): CoordinatedReleaseMetadata {
  const packageRoot = join(root, "packages");
  const manifests = readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packageRoot, entry.name, "package.json"))
    .filter((path) => existsSync(path))
    .map((path) => record(readJson(path), "KAF_RELEASE_PACKAGE_MANIFEST_INVALID"))
    .filter((manifest) => manifest["private"] !== true);
  if (manifests.length === 0) throw new Error("KAF_RELEASE_PACKAGES_EMPTY");
  const packageNames = manifests
    .map((manifest) => text(manifest["name"], "KAF_RELEASE_PACKAGE_NAME_INVALID"))
    .sort();
  const versions = new Set(
    manifests.map((manifest) => text(manifest["version"], "KAF_RELEASE_VERSION_INVALID")),
  );
  if (versions.size !== 1) throw new Error("KAF_RELEASE_PACKAGE_VERSION_MISMATCH");
  const version = [...versions][0];
  if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("KAF_RELEASE_VERSION_INVALID");
  }
  return Object.freeze({ version, packageNames: Object.freeze(packageNames) });
}

export function verifyRequestedReleaseVersion(requested: string): CoordinatedReleaseMetadata {
  const metadata = coordinatedReleaseMetadata();
  if (requested !== metadata.version) throw new Error("KAF_RELEASE_REQUESTED_VERSION_MISMATCH");
  return metadata;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  const requested = process.argv[2];
  if (requested === undefined) throw new Error("KAF_RELEASE_REQUESTED_VERSION_REQUIRED");
  process.stdout.write(`${JSON.stringify(verifyRequestedReleaseVersion(requested))}\n`);
}
