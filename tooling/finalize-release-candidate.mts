import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Bytes } from "./lib/release-integrity.mjs";

type JsonRecord = Record<string, unknown>;

export interface ReleaseCandidateContext {
  readonly repository: "lokomotifai/pactmark";
  readonly workflow: ".github/workflows/release.yml";
  readonly ref: "refs/heads/main";
  readonly environment: "release";
  readonly runner: "github-hosted";
  readonly sourceCommit: string;
}

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function digestFile(path: string, expected: unknown, code: string): string {
  const digest = sha256Bytes(readFileSync(path));
  if (digest !== expected) throw new Error(code);
  return `${digest.slice(7)}  ${basename(path)}`;
}

export function finalizeReleaseCandidate(
  directory: string,
  context: ReleaseCandidateContext,
): { readonly manifestDigest: string; readonly subjectCount: number } {
  const manifestPath = join(directory, "release-manifest.json");
  const manifest = record(
    JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    "KAF_RELEASE_CANDIDATE_MANIFEST_INVALID",
  );
  const releaseVersion = text(manifest.releaseVersion, "KAF_RELEASE_VERSION_INVALID");
  if (
    manifest.status !== "draft" ||
    manifest.metadataProfile !== "release" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(releaseVersion) ||
    manifest.publication !== "not_authorized"
  ) {
    throw new Error("KAF_RELEASE_CANDIDATE_STATE_INVALID");
  }
  const source = record(manifest.source, "KAF_RELEASE_CANDIDATE_SOURCE_INVALID");
  if (source.clean !== true || source.commit !== context.sourceCommit) {
    throw new Error("KAF_RELEASE_CANDIDATE_SOURCE_MISMATCH");
  }
  if (!/^[0-9a-f]{40}$/u.test(context.sourceCommit)) {
    throw new Error("KAF_RELEASE_CANDIDATE_COMMIT_INVALID");
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error("KAF_RELEASE_CANDIDATE_PACKAGES_EMPTY");
  }

  const subjects: string[] = [];
  for (const value of manifest.packages) {
    const entry = record(value, "KAF_RELEASE_CANDIDATE_PACKAGE_INVALID");
    if (entry.version !== releaseVersion) {
      throw new Error("KAF_RELEASE_CANDIDATE_PACKAGE_VERSION_MISMATCH");
    }
    const tarball = text(entry.tarball, "KAF_RELEASE_CANDIDATE_TARBALL_INVALID");
    if (tarball.includes("/") || tarball.includes("\\")) {
      throw new Error("KAF_RELEASE_CANDIDATE_TARBALL_INVALID");
    }
    const path = join(directory, "tarballs", tarball);
    const digest = sha256Bytes(readFileSync(path));
    if (digest !== entry.tarballSha256) {
      throw new Error("KAF_RELEASE_CANDIDATE_TARBALL_MISMATCH");
    }
    subjects.push(`${digest.slice(7)}  tarballs/${tarball}`);
  }

  const sbom = record(manifest.sbom, "KAF_RELEASE_CANDIDATE_SBOM_INVALID");
  const sbomName = text(sbom.path, "KAF_RELEASE_CANDIDATE_SBOM_INVALID");
  if (sbomName !== basename(sbomName)) throw new Error("KAF_RELEASE_CANDIDATE_SBOM_INVALID");
  subjects.push(
    digestFile(join(directory, sbomName), sbom.sha256, "KAF_RELEASE_CANDIDATE_SBOM_MISMATCH"),
  );

  manifest.status = "attested";
  manifest.attestation = {
    schemaVersion: "1",
    repository: context.repository,
    workflow: context.workflow,
    ref: context.ref,
    environment: context.environment,
    runner: context.runner,
    predicateType: "https://slsa.dev/provenance/v1",
  };
  writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`, { mode: 0o600 });
  const manifestDigest = sha256Bytes(readFileSync(manifestPath));
  subjects.push(`${manifestDigest.slice(7)}  release-manifest.json`);
  subjects.sort();

  writeFileSync(join(directory, "SHA256SUMS"), `${subjects.join("\n")}\n`, { mode: 0o600 });
  writeFileSync(
    join(directory, "attestation-input.json"),
    `${canonicalJson({
      schemaVersion: "1",
      predicateType: "https://slsa.dev/provenance/v1",
      claim: "github_artifact_attestation_pending",
      context: manifest.attestation,
      subjects: subjects.map((line) => {
        const [digest = "", name = ""] = line.split("  ");
        return { name, digest: { sha256: digest } };
      }),
    })}\n`,
    { mode: 0o600 },
  );
  return { manifestDigest, subjectCount: subjects.length };
}

function contextFromEnvironment(environment: NodeJS.ProcessEnv): ReleaseCandidateContext {
  const expectedWorkflowRef = "lokomotifai/pactmark/.github/workflows/release.yml@refs/heads/main";
  if (
    environment["GITHUB_REPOSITORY"] !== "lokomotifai/pactmark" ||
    environment["GITHUB_WORKFLOW_REF"] !== expectedWorkflowRef ||
    environment["GITHUB_REF"] !== "refs/heads/main" ||
    environment["PACTMARK_RELEASE_ENVIRONMENT"] !== "release" ||
    environment["PACTMARK_RELEASE_RUNNER"] !== "github-hosted"
  ) {
    throw new Error("KAF_RELEASE_CANDIDATE_CONTEXT_INVALID");
  }
  return {
    repository: "lokomotifai/pactmark",
    workflow: ".github/workflows/release.yml",
    ref: "refs/heads/main",
    environment: "release",
    runner: "github-hosted",
    sourceCommit: text(environment["GITHUB_SHA"], "KAF_RELEASE_CANDIDATE_COMMIT_INVALID"),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    throw new Error("Usage: finalize-release-candidate.mts <release-artifact-directory>");
  }
  const directory = process.argv[2];
  if (directory === undefined) throw new Error("KAF_RELEASE_CANDIDATE_DIRECTORY_REQUIRED");
  process.stdout.write(
    `${canonicalJson(finalizeReleaseCandidate(directory, contextFromEnvironment(process.env)))}\n`,
  );
}
