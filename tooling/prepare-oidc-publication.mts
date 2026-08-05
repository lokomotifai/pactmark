import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, sha256Bytes } from "./lib/release-integrity.mjs";

type JsonRecord = Record<string, unknown>;

const EXPECTED_PACKAGES = [
  "@pactmark/agent",
  "@pactmark/ai-sdk",
  "@pactmark/cli",
  "@pactmark/cloudflare",
  "@pactmark/core",
  "@pactmark/driver-postgres-worker",
  "@pactmark/evidence",
  "@pactmark/executor-in-process",
  "@pactmark/http",
  "@pactmark/mcp",
  "@pactmark/node",
  "@pactmark/otel",
  "@pactmark/policy",
  "@pactmark/runtime",
  "@pactmark/store-memory",
  "@pactmark/store-postgres",
  "@pactmark/testing",
  "@pactmark/vercel",
  "create-pactmark",
] as const;

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function npmVersion(): string {
  const invocation: readonly [string, readonly string[]] =
    process.platform === "win32"
      ? (() => {
          const npmCli = (process.env["PATH"] ?? "")
            .split(delimiter)
            .map((directory) => join(directory, "node_modules", "npm", "bin", "npm-cli.js"))
            .find((candidate) => existsSync(candidate));
          if (npmCli === undefined) throw new Error("KAF_RELEASE_TOOLCHAIN_UNAVAILABLE");
          return [process.execPath, [npmCli, "--version"]] as const;
        })()
      : ["npm", ["--version"]];
  const result = spawnSync(invocation[0], invocation[1], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) throw new Error("KAF_RELEASE_TOOLCHAIN_UNAVAILABLE");
  return result.stdout.trim();
}

export function prepareOidcPublicationConfig(
  artifactDirectory: string,
  inspectedAt = new Date().toISOString(),
): JsonRecord {
  const directory = resolve(artifactDirectory);
  const manifestPath = join(directory, "release-manifest.json");
  const sourceManifestPath = join(directory, "source-manifest.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = record(
    JSON.parse(manifestBytes.toString("utf8")) as unknown,
    "KAF_RELEASE_MANIFEST_INVALID",
  );
  if (
    manifest["status"] !== "attested" ||
    manifest["metadataProfile"] !== "release" ||
    manifest["releaseVersion"] !== "0.1.1"
  ) {
    throw new Error("KAF_RELEASE_OIDC_MANIFEST_INVALID");
  }
  if (!Array.isArray(manifest["packages"])) throw new Error("KAF_RELEASE_PACKAGES_EMPTY");
  const packageNames = manifest["packages"]
    .map((value) =>
      text(
        record(value, "KAF_RELEASE_PACKAGE_ENTRY_INVALID")["name"],
        "KAF_RELEASE_PACKAGE_NAME_INVALID",
      ),
    )
    .sort();
  if (canonicalJson(packageNames) !== canonicalJson([...EXPECTED_PACKAGES].sort())) {
    throw new Error("KAF_RELEASE_OIDC_PACKAGE_SET_INVALID");
  }
  const trustedPublisher = {
    repository: "pactmark/pactmark",
    workflow: "release.yml",
    environment: "release",
    runner: "github-hosted" as const,
  };
  return {
    execute: true,
    mode: "public",
    registry: "https://registry.npmjs.org/",
    manifestPath,
    manifestSha256: sha256Bytes(manifestBytes),
    sourceManifestPath,
    tarballDirectory: join(directory, "tarballs"),
    publicAuthorization: {
      authorized: true,
      authMode: "oidc",
      repository: "pactmark/pactmark",
      workflow: ".github/workflows/release.yml",
      publisherWorkflow: "release.yml",
      ref: "refs/heads/main",
      environment: "release",
      runner: "github-hosted",
      tty: false,
      nodeVersion: process.version.replace(/^v/u, ""),
      npmVersion: npmVersion(),
      minimumNodeVersion: "22.14.0",
      minimumNpmVersion: "11.5.1",
      packageAuthorities: Object.fromEntries(
        EXPECTED_PACKAGES.map((name) => [
          name,
          {
            packageExists: true,
            scopeOwned: true,
            inspectedAt,
            trustedPublisher,
          },
        ]),
      ),
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) {
    throw new Error(
      "Usage: prepare-oidc-publication.mts <release-artifact-directory> <output-config.json>",
    );
  }
  const artifactDirectory = process.argv[2];
  const outputPath = process.argv[3];
  if (artifactDirectory === undefined || outputPath === undefined) {
    throw new Error("KAF_RELEASE_OIDC_CONFIG_ARGUMENT_REQUIRED");
  }
  writeFileSync(outputPath, `${canonicalJson(prepareOidcPublicationConfig(artifactDirectory))}\n`, {
    mode: 0o600,
  });
}
