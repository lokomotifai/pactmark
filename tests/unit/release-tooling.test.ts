import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyAdvisorySnapshot } from "../../tooling/advisory-snapshot.mjs";
import { auditReleaseCommands } from "../../tooling/audit-release-commands.mjs";
import { canonicalJson, sha256Bytes } from "../../tooling/lib/release-integrity.mjs";
import { repositoryRoot } from "../../tooling/lib/repository.mjs";
import { finalizeReleaseCandidate } from "../../tooling/finalize-release-candidate.mjs";
import { generateReleaseArtifacts } from "../../tooling/release-artifacts.mjs";
import verifyManifestJson from "../../tooling/verify-gates.json" with { type: "json" };
import { parseVerifyGateManifest, verifyGateScripts } from "../../tooling/verify-gate-manifest.mjs";
import { prepareOidcPublicationConfig } from "../../tooling/prepare-oidc-publication.mjs";

type JsonRecord = Record<string, unknown>;

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tarball(manifest: JsonRecord): Buffer {
  const content = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0, "utf8");
  writeOctal(header, content.length, 124, 12);
  header.fill(0x20, 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  writeOctal(
    header,
    header.reduce((sum, byte) => sum + byte, 0),
    148,
    8,
  );
  return gzipSync(
    Buffer.concat([
      header,
      content,
      Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length),
      Buffer.alloc(1024),
    ]),
  );
}

function withTemporary(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pactmark-release-tooling-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("release command audit", () => {
  it("detects executable registry mutations while excluding the named negative fixture", () => {
    withTemporary((directory) => {
      mkdirSync(join(directory, "tooling"), { recursive: true });
      mkdirSync(join(directory, "fixtures/security/raw-release-command"), { recursive: true });
      writeFileSync(join(directory, "safe.mts"), "export const command = 'npm pack';\n");
      const negativeFixture = readFileSync(
        join(repositoryRoot, "fixtures/security/raw-release-command/unsafe-package.json"),
        "utf8",
      );
      writeFileSync(join(directory, "package.json"), negativeFixture);
      writeFileSync(
        join(directory, "fixtures/security/raw-release-command/unsafe-package.json"),
        negativeFixture,
      );
      const findings = auditReleaseCommands(directory, [
        "fixtures/security/raw-release-command/unsafe-package.json",
        "package.json",
        "safe.mts",
      ]);
      expect(findings).toHaveLength(2);
      expect(findings.map(({ path }) => path)).toEqual(["package.json", "package.json"]);
    });
  });
});

describe("deterministic release artifacts", () => {
  it("prepares a token-free OIDC config only for the exact v0.1.2 package set", () => {
    withTemporary((directory) => {
      const packageNames = [
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
      ];
      writeFileSync(
        join(directory, "release-manifest.json"),
        `${JSON.stringify({
          status: "attested",
          metadataProfile: "release",
          releaseVersion: "0.1.2",
          packages: packageNames.map((name) => ({ name })),
        })}\n`,
      );
      const config = prepareOidcPublicationConfig(directory, "2026-08-05T12:00:00.000Z");
      expect(config).toMatchObject({
        execute: true,
        mode: "public",
        registry: "https://registry.npmjs.org/",
        publicAuthorization: {
          authMode: "oidc",
          repository: "pactmark/pactmark",
          publisherWorkflow: "release.yml",
          environment: "release",
          tty: false,
        },
      });
      expect(JSON.stringify(config)).not.toContain("TOKEN");
      expect(
        Object.keys(
          (config["publicAuthorization"] as JsonRecord)["packageAuthorities"] as JsonRecord,
        ),
      ).toHaveLength(19);
    });
  });

  it("writes byte-stable checksums, a non-empty CycloneDX 1.7 SBOM, manifest and attestation inputs", () => {
    withTemporary((directory) => {
      const core = join(directory, "pactmark-core.tgz");
      const agent = join(directory, "pactmark-agent.tgz");
      writeFileSync(
        core,
        tarball({ name: "@pactmark/core", version: "0.1.0", dependencies: { zod: "4.4.3" } }),
      );
      writeFileSync(
        agent,
        tarball({
          name: "@pactmark/agent",
          version: "0.1.0",
          dependencies: { "@pactmark/core": "0.1.0" },
        }),
      );
      const build = (outputDirectory: string) =>
        generateReleaseArtifacts({
          outputDirectory,
          metadataProfile: "local",
          releaseVersion: "0.1.0",
          source: { commit: "a".repeat(40), tree: "b".repeat(40), clean: true },
          sourceDateEpoch: 1_775_347_200,
          tarballs: [
            { path: agent, packageDirectory: "packages/agent" },
            { path: core, packageDirectory: "packages/core" },
          ],
          verificationArtifactPaths: [],
          nodeVersion: "24.5.0",
          pnpmVersion: "11.18.0",
          resolvedExternalDependencies: { zod: "4.4.3" },
        });
      const first = build(join(directory, "first"));
      const second = build(join(directory, "second"));
      expect(readFileSync(first.manifestPath)).toEqual(readFileSync(second.manifestPath));
      expect(readFileSync(first.sbomPath)).toEqual(readFileSync(second.sbomPath));
      const sbom = JSON.parse(readFileSync(first.sbomPath, "utf8")) as JsonRecord;
      expect(sbom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.7" });
      expect(sbom.components).toHaveLength(3);
      expect(sbom.serialNumber).toMatch(
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(readFileSync(first.checksumsPath, "utf8").split("\n").filter(Boolean)).toHaveLength(4);
      expect(JSON.parse(readFileSync(first.attestationInputPath, "utf8"))).toMatchObject({
        claim: "prepared_not_attested",
      });
    });
  });

  it("rejects non-exact internal versions", () => {
    withTemporary((directory) => {
      const core = join(directory, "core.tgz");
      const agent = join(directory, "agent.tgz");
      writeFileSync(core, tarball({ name: "@pactmark/core", version: "0.1.0" }));
      writeFileSync(
        agent,
        tarball({
          name: "@pactmark/agent",
          version: "0.1.0",
          dependencies: { "@pactmark/core": "workspace:*" },
        }),
      );
      expect(() =>
        generateReleaseArtifacts({
          outputDirectory: join(directory, "output"),
          metadataProfile: "local",
          releaseVersion: "0.1.0",
          source: { commit: "a".repeat(40), tree: "b".repeat(40), clean: true },
          sourceDateEpoch: 1,
          tarballs: [
            { path: core, packageDirectory: "packages/core" },
            { path: agent, packageDirectory: "packages/agent" },
          ],
          verificationArtifactPaths: [],
          nodeVersion: "24.5.0",
          pnpmVersion: "11.18.0",
          resolvedExternalDependencies: {},
        }),
      ).toThrow("KAF_RELEASE_INTERNAL_DEPENDENCY_NOT_EXACT");
    });
  });

  it("freezes exact release subjects for the protected GitHub attestation context", () => {
    withTemporary((directory) => {
      const artifactDirectory = join(directory, "candidate");
      const tarballDirectory = join(artifactDirectory, "tarballs");
      mkdirSync(tarballDirectory, { recursive: true });
      const core = join(tarballDirectory, "pactmark-core.tgz");
      writeFileSync(core, tarball({ name: "@pactmark/core", version: "0.1.2" }));
      generateReleaseArtifacts({
        outputDirectory: artifactDirectory,
        metadataProfile: "release",
        releaseVersion: "0.1.2",
        source: { commit: "a".repeat(40), tree: "b".repeat(64), clean: true },
        sourceDateEpoch: 1_775_347_200,
        tarballs: [{ path: core, packageDirectory: "packages/core" }],
        verificationArtifactPaths: [],
        nodeVersion: "24.18.1",
        pnpmVersion: "11.18.0",
        resolvedExternalDependencies: {},
      });
      const result = finalizeReleaseCandidate(artifactDirectory, {
        repository: "pactmark/pactmark",
        workflow: ".github/workflows/release.yml",
        ref: "refs/heads/main",
        environment: "release",
        runner: "github-hosted",
        sourceCommit: "a".repeat(40),
      });
      expect(result).toMatchObject({ subjectCount: 3 });
      expect(
        JSON.parse(readFileSync(join(artifactDirectory, "release-manifest.json"), "utf8")),
      ).toMatchObject({
        status: "attested",
        publication: "not_authorized",
        attestation: {
          repository: "pactmark/pactmark",
          workflow: ".github/workflows/release.yml",
          ref: "refs/heads/main",
          environment: "release",
          runner: "github-hosted",
        },
      });
      const checksums = readFileSync(join(artifactDirectory, "SHA256SUMS"), "utf8");
      expect(checksums).toContain("  tarballs/pactmark-core.tgz");
      expect(checksums).toContain("  release-manifest.json");
      expect(
        JSON.parse(readFileSync(join(artifactDirectory, "attestation-input.json"), "utf8")),
      ).toMatchObject({ claim: "github_artifact_attestation_pending" });
    });
  });

  it("refuses to freeze a dirty or different source commit", () => {
    withTemporary((directory) => {
      const tarballDirectory = join(directory, "tarballs");
      mkdirSync(tarballDirectory, { recursive: true });
      const core = join(tarballDirectory, "core.tgz");
      writeFileSync(core, tarball({ name: "@pactmark/core", version: "0.1.2" }));
      generateReleaseArtifacts({
        outputDirectory: directory,
        metadataProfile: "release",
        releaseVersion: "0.1.2",
        source: { commit: "a".repeat(40), tree: "b".repeat(64), clean: true },
        sourceDateEpoch: 1,
        tarballs: [{ path: core, packageDirectory: "packages/core" }],
        verificationArtifactPaths: [],
        nodeVersion: "24.18.1",
        pnpmVersion: "11.18.0",
        resolvedExternalDependencies: {},
      });
      expect(() =>
        finalizeReleaseCandidate(directory, {
          repository: "pactmark/pactmark",
          workflow: ".github/workflows/release.yml",
          ref: "refs/heads/main",
          environment: "release",
          runner: "github-hosted",
          sourceCommit: "c".repeat(40),
        }),
      ).toThrow("KAF_RELEASE_CANDIDATE_SOURCE_MISMATCH");
    });
  });
});

function advisoryFiles(
  directory: string,
  overrides: JsonRecord = {},
): { snapshot: string; checksum: string; lockfile: string } {
  const lockfile = join(directory, "pnpm-lock.yaml");
  writeFileSync(lockfile, "lockfileVersion: '9.0'\n");
  const material: JsonRecord = {
    schemaVersion: "1",
    source: {
      kind: "upstream-export",
      url: "https://example.test/advisory-export",
      databaseVersion: "fixture-1",
      retrievedAt: "2026-08-02T00:00:00.000Z",
    },
    lockfileDigest: sha256Bytes(readFileSync(lockfile)),
    advisories: [],
    ...overrides,
  };
  material.canonicalDigest = `sha256:${createHash("sha256").update(canonicalJson(material)).digest("hex")}`;
  const snapshot = join(directory, "snapshot.json");
  writeFileSync(snapshot, `${canonicalJson(material)}\n`);
  const checksum = join(directory, "snapshot.sha256");
  writeFileSync(checksum, `${sha256Bytes(readFileSync(snapshot))}\n`);
  return { snapshot, checksum, lockfile };
}

describe("offline advisory snapshot", () => {
  it("binds checksum, canonical content, exact lockfile and freshness", () => {
    withTemporary((directory) => {
      const files = advisoryFiles(directory);
      expect(
        verifyAdvisorySnapshot({
          snapshotPath: files.snapshot,
          checksumPath: files.checksum,
          lockfilePath: files.lockfile,
          now: new Date("2026-08-03T00:00:00.000Z"),
          maximumAgeDays: 7,
        }),
      ).toMatchObject({ advisoryCount: 0 });
    });
  });

  it("fails closed for stale data, changed lockfile, changed checksum and unresolved high findings", () => {
    for (const attack of ["stale", "lockfile", "checksum", "finding"] as const) {
      withTemporary((directory) => {
        const files = advisoryFiles(
          directory,
          attack === "finding" ? { advisories: [{ id: "ADV-1", severity: "critical" }] } : {},
        );
        if (attack === "lockfile") writeFileSync(files.lockfile, "lockfileVersion: 'changed'\n");
        if (attack === "checksum") writeFileSync(files.checksum, `sha256:${"0".repeat(64)}\n`);
        const invoke = () =>
          verifyAdvisorySnapshot({
            snapshotPath: files.snapshot,
            checksumPath: files.checksum,
            lockfilePath: files.lockfile,
            now: new Date(
              attack === "stale" ? "2026-09-03T00:00:00.000Z" : "2026-08-03T00:00:00.000Z",
            ),
            maximumAgeDays: 7,
          });
        expect(invoke).toThrow(
          attack === "stale"
            ? "KAF_ADVISORY_SNAPSHOT_STALE"
            : attack === "lockfile"
              ? "KAF_ADVISORY_LOCKFILE_MISMATCH"
              : attack === "checksum"
                ? "KAF_ADVISORY_CHECKSUM_MISMATCH"
                : "KAF_ADVISORY_BLOCKING_FINDING",
        );
      });
    }
  });
});

describe("machine-readable verify manifest", () => {
  it("rejects absent, duplicated, non-invoked, no-op, skipped and accidentally aggregated external gates", () => {
    const manifest = parseVerifyGateManifest(verifyManifestJson);
    const scripts: Record<string, string> = {};
    for (const [aggregate, gates] of Object.entries(manifest.aggregates)) {
      scripts[aggregate] = gates.map((gate) => `pnpm ${gate}`).join(" && ");
      for (const gate of gates) scripts[gate] ??= `vitest run ${gate}.test.ts`;
    }
    for (const gate of manifest.externalGates)
      scripts[gate] = `node tooling/${gate.replaceAll(":", "-")}.mts`;
    expect(() => {
      verifyGateScripts(manifest, scripts);
    }).not.toThrow();
    expect(() => {
      verifyGateScripts(manifest, { ...scripts, lint: "echo ok" });
    }).toThrow("KAF_VERIFY_GATE_NOOP:lint");
    expect(() => {
      verifyGateScripts(manifest, { ...scripts, lint: "KAF_SKIP=1 vitest run lint.test.ts" });
    }).toThrow("KAF_VERIFY_GATE_NOOP:lint");
    expect(() => {
      verifyGateScripts(manifest, {
        ...scripts,
        verify: scripts.verify?.replace("pnpm lint && ", "") ?? "",
      });
    }).toThrow("KAF_VERIFY_GATE_NOT_IN_AGGREGATE:verify:lint");
    const missing = { ...scripts };
    delete missing["test:sandbox-contract"];
    expect(() => {
      verifyGateScripts(manifest, missing);
    }).toThrow("KAF_VERIFY_SCRIPT_MISSING:test:sandbox-contract");
    const duplicated = structuredClone(verifyManifestJson) as JsonRecord;
    (recordObject(recordObject(duplicated.aggregates).verify) as unknown as unknown[]).push(
      "audit:licenses",
    );
    scripts.verify = `${scripts.verify ?? ""} && pnpm audit:licenses`;
    expect(() => {
      verifyGateScripts(parseVerifyGateManifest(duplicated), scripts);
    }).toThrow("KAF_VERIFY_GATE_OWNERSHIP_DUPLICATE:audit:licenses");
  });
});

function recordObject(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object") throw new Error("invalid record");
  return value as JsonRecord;
}
