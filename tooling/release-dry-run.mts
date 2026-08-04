import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packPublishablePackages } from "./consumer/packed-artifacts.mjs";
import { generateReleaseArtifacts } from "./release-artifacts.mjs";
import { canonicalJson, sha256Bytes } from "./lib/release-integrity.mjs";
import { gitFiles, gitSourceState, repositoryRoot, sha256File } from "./lib/repository.mjs";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

const outputDirectory = join(repositoryRoot, ".artifacts", "release-dry-run");
const tarballDirectory = join(outputDirectory, "tarballs");
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(tarballDirectory, { recursive: true });

const files = gitFiles()
  .filter((path) => !path.startsWith("briefs/") && !path.startsWith("research/"))
  .map((path) => ({ path, digest: sha256File(join(repositoryRoot, path)) }));
const sourceManifest = {
  schemaVersion: "1",
  product: "pactmark",
  profile: "release",
  publication: "not_authorized",
  files,
};
const sourceManifestPath = join(outputDirectory, "source-manifest.json");
writeFileSync(sourceManifestPath, `${canonicalJson(sourceManifest)}\n`, { mode: 0o600 });

const packageDirectories = readdirSync(join(repositoryRoot, "packages"))
  .map((name) => `packages/${name}`)
  .filter((directory) => {
    const manifest = record(
      JSON.parse(readFileSync(join(repositoryRoot, directory, "package.json"), "utf8")) as unknown,
      "KAF_RELEASE_PACKAGE_MANIFEST_INVALID",
    );
    return manifest["private"] !== true;
  })
  .sort();
const resolvedExternalDependencies: Record<string, string> = {};
for (const packageDirectory of packageDirectories) {
  const manifest = record(
    JSON.parse(
      readFileSync(join(repositoryRoot, packageDirectory, "package.json"), "utf8"),
    ) as unknown,
    "KAF_RELEASE_PACKAGE_MANIFEST_INVALID",
  );
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    for (const [name, value] of Object.entries(
      record(dependencies, "KAF_RELEASE_DEPENDENCIES_INVALID"),
    )) {
      if (typeof value !== "string" || value.startsWith("workspace:")) continue;
      const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)
        ? value
        : String(
            record(
              JSON.parse(
                readFileSync(
                  join(repositoryRoot, packageDirectory, "node_modules", name, "package.json"),
                  "utf8",
                ),
              ) as unknown,
              `KAF_RELEASE_EXTERNAL_DEPENDENCY_UNRESOLVED:${name}`,
            )["version"],
          );
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(exactVersion)) {
        throw new Error(`KAF_RELEASE_EXTERNAL_DEPENDENCY_UNRESOLVED:${name}:${value}`);
      }
      const existing = resolvedExternalDependencies[name];
      if (existing !== undefined && existing !== exactVersion) {
        throw new Error(`KAF_RELEASE_EXTERNAL_DEPENDENCY_CONFLICT:${name}`);
      }
      resolvedExternalDependencies[name] = exactVersion;
    }
  }
}

const npmCacheDirectory = mkdtempSync(join(tmpdir(), "pactmark-release-npm-cache-"));
const packedArtifacts = await (async () => {
  try {
    return await packPublishablePackages({
      destination: tarballDirectory,
      npmCacheDirectory,
    });
  } finally {
    rmSync(npmCacheDirectory, { recursive: true, force: true });
  }
})();
const tarballs = packedArtifacts.map(({ tarballPath, packageDirectory }) => ({
  path: tarballPath,
  packageDirectory,
}));

const sourceDigest = sha256Bytes(Buffer.from(canonicalJson(sourceManifest)));
const sourceState = gitSourceState();
const artifacts = generateReleaseArtifacts({
  outputDirectory,
  metadataProfile: "release",
  releaseVersion: "0.1.0",
  source: { commit: sourceState.commit, tree: sourceDigest, clean: sourceState.clean },
  sourceDateEpoch: Number(process.env["SOURCE_DATE_EPOCH"] ?? "0"),
  tarballs,
  verificationArtifactPaths: [sourceManifestPath],
  nodeVersion: process.version,
  pnpmVersion: "11.18.0",
  resolvedExternalDependencies,
});
for (const path of Object.values(artifacts)) {
  if (!readFileSync(path).byteLength) throw new Error("KAF_RELEASE_ARTIFACT_EMPTY");
}
process.stdout.write(
  `${JSON.stringify({ sourceFiles: files.length, packages: tarballs.length, ...artifacts })}\n`,
);
