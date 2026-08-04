import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { canonicalJson, readNpmPackedManifest, sha256Bytes } from "./lib/release-integrity.mjs";

type JsonRecord = Record<string, unknown>;

export interface ReleaseArtifactInput {
  readonly outputDirectory: string;
  readonly metadataProfile: "local" | "release";
  readonly releaseVersion: string;
  readonly source: { readonly commit: string; readonly tree: string; readonly clean: boolean };
  readonly sourceDateEpoch: number;
  readonly tarballs: readonly { readonly path: string; readonly packageDirectory: string }[];
  readonly verificationArtifactPaths: readonly string[];
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
  readonly resolvedExternalDependencies: Readonly<Record<string, string>>;
}

function record(value: unknown, error: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as JsonRecord;
}

function exactString(value: unknown, error: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(error);
  return value;
}

function dependencyMap(manifest: JsonRecord): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const value = manifest[field];
    if (value === undefined) continue;
    for (const [name, version] of Object.entries(
      record(value, "KAF_RELEASE_DEPENDENCIES_INVALID"),
    )) {
      result[name] = exactString(version, "KAF_RELEASE_DEPENDENCY_VERSION_INVALID");
    }
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function generateReleaseArtifacts(input: ReleaseArtifactInput): {
  readonly manifestPath: string;
  readonly sbomPath: string;
  readonly checksumsPath: string;
  readonly attestationInputPath: string;
} {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(input.releaseVersion)) {
    throw new Error("KAF_RELEASE_VERSION_INVALID");
  }
  if (!Number.isSafeInteger(input.sourceDateEpoch) || input.sourceDateEpoch < 0) {
    throw new Error("KAF_RELEASE_SOURCE_DATE_EPOCH_INVALID");
  }
  if (input.tarballs.length === 0) throw new Error("KAF_RELEASE_TARBALLS_EMPTY");

  const packages = input.tarballs.map(({ path, packageDirectory }) => {
    if (!/^(?:packages|apps)\/[a-z0-9-]+$/u.test(packageDirectory)) {
      throw new Error("KAF_RELEASE_DIRECTORY_INVALID");
    }
    const bytes = readFileSync(path);
    const packedManifest = record(
      readNpmPackedManifest(bytes),
      "KAF_RELEASE_PACKED_MANIFEST_INVALID",
    );
    const name = exactString(packedManifest.name, "KAF_RELEASE_PACKAGE_NAME_INVALID");
    const version = exactString(packedManifest.version, "KAF_RELEASE_PACKAGE_VERSION_INVALID");
    if (version !== input.releaseVersion) throw new Error("KAF_RELEASE_VERSION_MISMATCH");
    return {
      name,
      version,
      directory: packageDirectory,
      tarball: basename(path),
      tarballSha256: sha256Bytes(bytes),
      packedManifestSha256: sha256Bytes(Buffer.from(canonicalJson(packedManifest))),
      dependencies: dependencyMap(packedManifest),
      packedManifest,
    };
  });
  packages.sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(packages.map(({ name }) => name)).size !== packages.length) {
    throw new Error("KAF_RELEASE_DUPLICATE_PACKAGE");
  }
  const releaseNames = new Set(packages.map(({ name }) => name));
  const externalNames = new Set<string>();
  for (const entry of packages) {
    for (const [name, version] of Object.entries(entry.dependencies)) {
      if (releaseNames.has(name) && version !== input.releaseVersion) {
        throw new Error("KAF_RELEASE_INTERNAL_DEPENDENCY_NOT_EXACT");
      }
      if (!releaseNames.has(name)) externalNames.add(name);
    }
  }
  const externalComponents = [...externalNames].sort().map((name) => {
    const version = input.resolvedExternalDependencies[name];
    if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      throw new Error("KAF_RELEASE_EXTERNAL_DEPENDENCY_UNRESOLVED");
    }
    return {
      type: "library",
      name,
      version,
      bomRef: `pkg:npm/${encodeURIComponent(name)}@${version}`,
      properties: [{ name: "pactmark:inventory-source", value: "resolved-lockfile-input" }],
    };
  });

  mkdirSync(input.outputDirectory, { recursive: true });
  const verificationArtifacts = input.verificationArtifactPaths
    .map((path) => ({
      path: relative(input.outputDirectory, path).replaceAll("\\", "/"),
      sha256: sha256Bytes(readFileSync(path)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const timestamp = new Date(input.sourceDateEpoch * 1000).toISOString();
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    serialNumber: stableSerialNumber(packages.map(({ tarballSha256 }) => tarballSha256).join("\n")),
    version: 1,
    metadata: {
      timestamp,
      component: { type: "application", name: "pactmark-release", version: input.releaseVersion },
    },
    components: [
      ...packages.map((entry) => ({
        type: "library",
        name: entry.name,
        version: entry.version,
        bomRef: `pkg:npm/${encodeURIComponent(entry.name)}@${entry.version}`,
        hashes: [{ alg: "SHA-256", content: entry.tarballSha256.slice(7) }],
        properties: [{ name: "pactmark:source-directory", value: entry.directory }],
      })),
      ...externalComponents,
    ],
    dependencies: packages.map((entry) => ({
      ref: `pkg:npm/${encodeURIComponent(entry.name)}@${entry.version}`,
      dependsOn: Object.keys(entry.dependencies)
        .sort()
        .map((name) =>
          releaseNames.has(name)
            ? `pkg:npm/${encodeURIComponent(name)}@${input.releaseVersion}`
            : `pkg:npm/${encodeURIComponent(name)}@${String(input.resolvedExternalDependencies[name])}`,
        ),
    })),
  };
  const sbomPath = join(input.outputDirectory, "pactmark-release.cdx.json");
  writeFileSync(sbomPath, `${canonicalJson(sbom)}\n`, { mode: 0o600 });
  const sbomSha256 = sha256Bytes(readFileSync(sbomPath));
  const manifest = {
    schemaVersion: "1",
    status: "draft",
    metadataProfile: input.metadataProfile,
    releaseVersion: input.releaseVersion,
    source: input.source,
    build: {
      sourceDateEpoch: input.sourceDateEpoch,
      nodeVersion: input.nodeVersion,
      pnpmVersion: input.pnpmVersion,
    },
    packages,
    sbom: { path: basename(sbomPath), sha256: sbomSha256 },
    verificationArtifacts,
    publication: "not_authorized",
  };
  const manifestPath = join(input.outputDirectory, "release-manifest.json");
  writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`, { mode: 0o600 });
  const checksums = [
    ...packages.map((entry) => `${entry.tarballSha256.slice(7)}  tarballs/${entry.tarball}`),
    `${sbomSha256.slice(7)}  ${basename(sbomPath)}`,
    `${sha256Bytes(readFileSync(manifestPath)).slice(7)}  ${basename(manifestPath)}`,
  ].sort();
  const checksumsPath = join(input.outputDirectory, "SHA256SUMS");
  writeFileSync(checksumsPath, `${checksums.join("\n")}\n`, { mode: 0o600 });
  const attestationInputPath = join(input.outputDirectory, "attestation-input.json");
  writeFileSync(
    attestationInputPath,
    `${canonicalJson({
      schemaVersion: "1",
      predicateType: "https://slsa.dev/provenance/v1",
      claim: "prepared_not_attested",
      subjects: checksums.map((line) => {
        const [digest = "", name = ""] = line.split("  ");
        return { name, digest: { sha256: digest } };
      }),
    })}\n`,
    { mode: 0o600 },
  );
  return { manifestPath, sbomPath, checksumsPath, attestationInputPath };
}

function stableSerialNumber(material: string): string {
  const hex = sha256Bytes(Buffer.from(material)).slice(7, 39).split("");
  hex[12] = "5";
  const variant = Number.parseInt(hex[16] ?? "0", 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `urn:uuid:${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
