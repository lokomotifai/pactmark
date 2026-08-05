import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import casesJson from "../../fixtures/security/release-boundary-cases.json" with { type: "json" };
import { sha256Bytes } from "../../tooling/lib/release-integrity.mjs";
import {
  executePublishPlan,
  executePublishPlanAsync,
  inspectPublicRegistry,
  isSafeSourceManifestPath,
  npmPublishArguments,
  preparePublishPlan,
  runReleasePublisher,
  type PublicAuthorization,
  type PublishOperation,
} from "../../tooling/release-publish.mjs";

type JsonRecord = Record<string, unknown>;

interface BoundaryCase {
  readonly id: string;
  readonly kind: string;
  readonly field?: string;
  readonly value?: unknown;
  readonly secondaryField?: string;
  readonly secondaryValue?: unknown;
  readonly error: string;
}

function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid test record");
  return value as JsonRecord;
}

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function npmTarball(manifest: JsonRecord): Buffer {
  const content = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0, "utf8");
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, content.length, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  writeOctal(
    header,
    header.reduce((sum, byte) => sum + byte, 0),
    148,
    8,
  );
  const padding = Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length);
  return gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]));
}

function setPath(target: JsonRecord, path: string, value: unknown): void {
  const [head, tail] = path.split(".");
  if (head === undefined) throw new Error("invalid path");
  if (tail === undefined) target[head] = value;
  else record(target[head])[tail] = value;
}

function deletePath(target: JsonRecord, path: string): void {
  const [head, tail] = path.split(".");
  if (head === undefined) throw new Error("invalid path");
  if (tail === undefined) target[head] = undefined;
  else record(target[head])[tail] = undefined;
}

const basePacked = (): JsonRecord => ({
  name: "@pactmark/core",
  version: "0.1.0",
  repository: {
    type: "git",
    url: "git+https://github.com/pactmark/pactmark.git",
    directory: "packages/core",
  },
  publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
});

const baseAuthorization = (): PublicAuthorization => ({
  authorized: true,
  authMode: "oidc",
  repository: "pactmark/pactmark",
  workflow: ".github/workflows/release.yml",
  publisherWorkflow: "release.yml",
  ref: "refs/tags/v0.1.0",
  environment: "release",
  runner: "github-hosted",
  tty: false,
  nodeVersion: "24.5.0",
  npmVersion: "11.5.1",
  minimumNodeVersion: "22.14.0",
  minimumNpmVersion: "11.5.1",
  packageAuthorities: {
    "@pactmark/core": {
      packageExists: true,
      scopeOwned: true,
      inspectedAt: "2026-08-03T00:00:00.000Z",
      trustedPublisher: {
        repository: "pactmark/pactmark",
        workflow: "release.yml",
        environment: "release",
        runner: "github-hosted",
      },
    },
  },
});

let temporary = "";
let sequence = 0;

beforeAll(() => {
  temporary = mkdtempSync(join(tmpdir(), "pactmark-release-security-"));
});

afterAll(() => {
  rmSync(temporary, { recursive: true, force: true });
});

function context(packed = basePacked()): {
  readonly packed: JsonRecord;
  readonly manifest: JsonRecord;
  readonly authorization: PublicAuthorization;
  readonly writePacked: () => void;
} {
  sequence += 1;
  const tarballName = `package-${String(sequence)}.tgz`;
  const tarballPath = join(temporary, tarballName);
  const packageName = String(packed.name);
  const entry: JsonRecord = {
    name: packageName,
    version: String(packed.version),
    directory: packageName === "create-pactmark" ? "packages/create-pactmark" : "packages/core",
    tarball: tarballName,
    tarballSha256: "",
    dependencies: {},
  };
  const writePacked = (): void => {
    const bytes = npmTarball(packed);
    writeFileSync(tarballPath, bytes);
    entry.tarballSha256 = sha256Bytes(bytes);
  };
  writePacked();
  return {
    packed,
    manifest: {
      schemaVersion: "1",
      status: "attested",
      metadataProfile: "release",
      releaseVersion: "0.1.0",
      source: { commit: "a".repeat(40), tree: "b".repeat(40), clean: true },
      packages: [entry],
      attestation: {
        repository: "pactmark/pactmark",
        workflow: ".github/workflows/release.yml",
        ref: "refs/tags/v0.1.0",
        environment: "release",
        runner: "github-hosted",
      },
    },
    authorization: baseAuthorization(),
    writePacked,
  };
}

describe("guarded release publisher adversarial matrix", () => {
  const cases = casesJson as readonly BoundaryCase[];
  it.each(cases)("rejects $id", (testCase) => {
    const state = context();
    let mode: "loopback" | "public" = "public";
    let registry = "https://registry.npmjs.org/";
    let authorization: PublicAuthorization | undefined = state.authorization;
    if (testCase.kind === "loopback_registry") {
      mode = "loopback";
      registry = String(testCase.value);
    } else if (testCase.kind === "public_registry") {
      registry = String(testCase.value);
    } else if (testCase.kind === "manifest") {
      state.manifest[String(testCase.field)] = testCase.value;
    } else if (testCase.kind === "source") {
      record(state.manifest.source)[String(testCase.field)] = testCase.value;
    } else if (testCase.kind === "authorization_absent") {
      authorization = undefined;
    } else if (testCase.kind === "authorization") {
      const mutable = record(structuredClone(state.authorization));
      mutable[String(testCase.field)] = testCase.value;
      if (testCase.secondaryField !== undefined)
        mutable[testCase.secondaryField] = testCase.secondaryValue;
      authorization = mutable as unknown as PublicAuthorization;
    } else if (testCase.kind === "entry") {
      record((state.manifest.packages as unknown[])[0])[String(testCase.field)] = testCase.value;
    } else if (testCase.kind === "entry_dependency") {
      record(record((state.manifest.packages as unknown[])[0]).dependencies)["@pactmark/core"] =
        testCase.value;
    } else if (testCase.kind === "packed") {
      setPath(state.packed, String(testCase.field), testCase.value);
      state.writePacked();
    } else if (testCase.kind === "packed_delete") {
      deletePath(state.packed, String(testCase.field));
      state.writePacked();
    }
    const invoke = (): unknown =>
      preparePublishPlan({
        mode,
        registry,
        manifest: state.manifest,
        tarballDirectory: temporary,
        ...(authorization === undefined ? {} : { publicAuthorization: authorization }),
      });
    expect(invoke).toThrow(testCase.error);
  });

  it("hard-limits loopback publication and emits exact candidate arguments", () => {
    const state = context();
    state.manifest.status = "draft";
    state.manifest.metadataProfile = "local";
    const plan = preparePublishPlan({
      mode: "loopback",
      registry: "http://127.0.0.1:4873/",
      manifest: state.manifest,
      tarballDirectory: temporary,
    });
    expect(plan.operations).toHaveLength(1);
    expect(npmPublishArguments(plan.operations[0]!)).toEqual([
      "publish",
      plan.operations[0]!.tarballPath,
      "--registry=http://127.0.0.1:4873/",
      "--tag=candidate",
      "--ignore-scripts",
      "--access=public",
    ]);
  });

  it("prepares exact public latest arguments without performing a registry write", () => {
    const state = context();
    const plan = preparePublishPlan({
      mode: "public",
      registry: "https://registry.npmjs.org/",
      manifest: state.manifest,
      tarballDirectory: temporary,
      publicAuthorization: state.authorization,
    });
    expect(plan.operations).toHaveLength(1);
    expect(npmPublishArguments(plan.operations[0]!)).toEqual([
      "publish",
      plan.operations[0]!.tarballPath,
      "--registry=https://registry.npmjs.org/",
      "--tag=latest",
      "--ignore-scripts",
      "--access=public",
    ]);
  });

  it("accepts framework catch-all names while rejecting path traversal segments", () => {
    expect(isSafeSourceManifestPath("apps/nextjs-vercel/app/api/agent/[...kaf]/route.ts")).toBe(
      true,
    );
    expect(isSafeSourceManifestPath("packages/core/src/file..name.ts")).toBe(true);
    for (const path of [
      "../secret",
      "safe/../secret",
      "safe/./secret",
      "/absolute/path",
      "safe\\windows",
      "safe//empty",
    ]) {
      expect(isSafeSourceManifestPath(path)).toBe(false);
    }
  });

  it("permits an exact-byte interactive bootstrap resume for an already-created package", () => {
    const state = context();
    const authorization = {
      ...state.authorization,
      authMode: "interactive-bootstrap" as const,
      tty: true,
    };
    const plan = preparePublishPlan({
      mode: "public",
      registry: "https://registry.npmjs.org/",
      manifest: state.manifest,
      tarballDirectory: temporary,
      publicAuthorization: authorization,
    });
    expect(plan.operations).toHaveLength(1);
  });

  it("enforces the current trusted-publishing toolchain floor independently of config", () => {
    const state = context();
    const authorization = {
      ...state.authorization,
      nodeVersion: "22.13.0",
      npmVersion: "11.5.0",
      minimumNodeVersion: "0.0.0",
      minimumNpmVersion: "0.0.0",
    };
    expect(() =>
      preparePublishPlan({
        mode: "public",
        registry: "https://registry.npmjs.org/",
        manifest: state.manifest,
        tarballDirectory: temporary,
        publicAuthorization: authorization,
      }),
    ).toThrow("KAF_RELEASE_NODE_FLOOR_UNMET");
  });

  it("inspects public registry bytes anonymously instead of trusting metadata alone", async () => {
    const state = context();
    const plan = preparePublishPlan({
      mode: "public",
      registry: "https://registry.npmjs.org/",
      manifest: state.manifest,
      tarballDirectory: temporary,
      publicAuthorization: state.authorization,
    });
    const operation = plan.operations[0]!;
    const tarball = readFileSync(operation.tarballPath);
    const inspection = await inspectPublicRegistry(operation, (input) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      return Promise.resolve(
        url.pathname.endsWith(".tgz")
          ? new Response(Uint8Array.from(tarball))
          : Response.json({
              name: operation.packageName,
              version: operation.version,
              dist: {
                tarball: "https://registry.npmjs.org/@pactmark/core/-/core-0.1.0.tgz",
              },
            }),
      );
    });
    expect(inspection).toEqual({
      state: "present",
      public: true,
      tarballSha256: sha256Bytes(tarball),
    });
  });

  it("refuses public execution without a real human-attended TTY", async () => {
    const state = context();
    const manifestPath = join(temporary, `manifest-${String(sequence)}.json`);
    const sourceManifestPath = join(temporary, `source-${String(sequence)}.json`);
    const configPath = join(temporary, `config-${String(sequence)}.json`);
    const manifestBytes = Buffer.from(`${JSON.stringify(state.manifest)}\n`);
    writeFileSync(manifestPath, manifestBytes);
    writeFileSync(sourceManifestPath, "{}\n");
    const authorization = {
      ...state.authorization,
      authMode: "interactive-bootstrap" as const,
      tty: true,
      bootstrapUser: "fatihguner",
      bootstrapOrganization: "pactmark",
      packageAuthorities: {
        "@pactmark/core": {
          packageExists: false,
          scopeOwned: true,
          inspectedAt: new Date().toISOString(),
        },
      },
    };
    writeFileSync(
      configPath,
      JSON.stringify({
        execute: true,
        mode: "public",
        registry: "https://registry.npmjs.org/",
        manifestPath,
        manifestSha256: sha256Bytes(manifestBytes),
        sourceManifestPath,
        tarballDirectory: temporary,
        publicAuthorization: authorization,
      }),
    );
    const previousCi = process.env["CI"];
    const previousGitHubActions = process.env["GITHUB_ACTIONS"];
    const executionArguments = [
      "--config",
      configPath,
      "--authorize-public-release",
      "publish-pactmark-0.1.0",
    ];
    try {
      process.env["CI"] = "true";
      await expect(runReleasePublisher(executionArguments)).rejects.toThrow(
        "KAF_RELEASE_BOOTSTRAP_CI_FORBIDDEN",
      );
      delete process.env["CI"];
      delete process.env["GITHUB_ACTIONS"];
      await expect(runReleasePublisher(executionArguments)).rejects.toThrow(
        "KAF_RELEASE_INTERACTIVE_TTY_REQUIRED",
      );
    } finally {
      if (previousCi === undefined) delete process.env["CI"];
      else process.env["CI"] = previousCi;
      if (previousGitHubActions === undefined) delete process.env["GITHUB_ACTIONS"];
      else process.env["GITHUB_ACTIONS"] = previousGitHubActions;
    }
  });

  it("refuses OIDC execution outside GitHub Actions and rejects token fallback", async () => {
    const state = context();
    const manifestPath = join(temporary, `manifest-${String(sequence)}.json`);
    const sourceManifestPath = join(temporary, `source-${String(sequence)}.json`);
    const configPath = join(temporary, `config-${String(sequence)}.json`);
    const manifestBytes = Buffer.from(`${JSON.stringify(state.manifest)}\n`);
    writeFileSync(manifestPath, manifestBytes);
    writeFileSync(sourceManifestPath, "{}\n");
    writeFileSync(
      configPath,
      JSON.stringify({
        execute: true,
        mode: "public",
        registry: "https://registry.npmjs.org/",
        manifestPath,
        manifestSha256: sha256Bytes(manifestBytes),
        sourceManifestPath,
        tarballDirectory: temporary,
        publicAuthorization: state.authorization,
      }),
    );
    const saved = {
      ci: process.env["CI"],
      githubActions: process.env["GITHUB_ACTIONS"],
      nodeAuthToken: process.env["NODE_AUTH_TOKEN"],
    };
    const executionArguments = [
      "--config",
      configPath,
      "--authorize-public-release",
      "publish-pactmark-0.1.0",
    ];
    try {
      delete process.env["CI"];
      delete process.env["GITHUB_ACTIONS"];
      await expect(runReleasePublisher(executionArguments)).rejects.toThrow(
        "KAF_RELEASE_OIDC_GITHUB_HOST_REQUIRED",
      );
      process.env["CI"] = "true";
      process.env["GITHUB_ACTIONS"] = "true";
      process.env["NODE_AUTH_TOKEN"] = "forbidden-test-token";
      await expect(runReleasePublisher(executionArguments)).rejects.toThrow(
        "KAF_RELEASE_AUTOMATION_TOKEN_FORBIDDEN",
      );
    } finally {
      if (saved.ci === undefined) delete process.env["CI"];
      else process.env["CI"] = saved.ci;
      if (saved.githubActions === undefined) delete process.env["GITHUB_ACTIONS"];
      else process.env["GITHUB_ACTIONS"] = saved.githubActions;
      if (saved.nodeAuthToken === undefined) delete process.env["NODE_AUTH_TOKEN"];
      else process.env["NODE_AUTH_TOKEN"] = saved.nodeAuthToken;
    }
  });

  it("never retries an uncertain registry write", () => {
    const state = context();
    state.manifest.status = "draft";
    state.manifest.metadataProfile = "local";
    const plan = preparePublishPlan({
      mode: "loopback",
      registry: "http://[::1]:4873/",
      manifest: state.manifest,
      tarballDirectory: temporary,
    });
    let publishes = 0;
    expect(() => {
      executePublishPlan(plan, {
        inspect: () => ({ state: "absent" }),
        publish: () => {
          publishes += 1;
          return { state: "uncertain" };
        },
      });
    }).toThrow("KAF_RELEASE_PUBLISH_UNCERTAIN_NO_RETRY");
    expect(publishes).toBe(1);
  });

  it("retries only read-only visibility checks after a confirmed publish", async () => {
    const state = context();
    state.manifest.status = "draft";
    state.manifest.metadataProfile = "local";
    const plan = preparePublishPlan({
      mode: "loopback",
      registry: "http://127.0.0.1:4873/",
      manifest: state.manifest,
      tarballDirectory: temporary,
    });
    const operation = plan.operations[0] as PublishOperation;
    let inspections = 0;
    let publishes = 0;
    await executePublishPlanAsync(
      plan,
      {
        inspect: () => {
          inspections += 1;
          if (inspections === 1) return Promise.resolve({ state: "absent" });
          if (inspections === 2) return Promise.resolve({ state: "uncertain" });
          if (inspections === 3) return Promise.resolve({ state: "absent" });
          return Promise.resolve({
            state: "present" as const,
            public: true,
            tarballSha256: sha256Bytes(readFileSync(operation.tarballPath)),
          });
        },
        publish: () => {
          publishes += 1;
          return Promise.resolve({ state: "published" });
        },
      },
      0,
    );
    expect(inspections).toBe(4);
    expect(publishes).toBe(1);
  });

  it("resumes only when existing public bytes exactly match", () => {
    const state = context();
    state.manifest.status = "draft";
    state.manifest.metadataProfile = "local";
    const plan = preparePublishPlan({
      mode: "loopback",
      registry: "http://127.0.0.1:4873/",
      manifest: state.manifest,
      tarballDirectory: temporary,
    });
    const operation = plan.operations[0] as PublishOperation;
    let publishes = 0;
    executePublishPlan(plan, {
      inspect: () => ({
        state: "present",
        public: true,
        tarballSha256: sha256Bytes(readFileSync(operation.tarballPath)),
      }),
      publish: () => {
        publishes += 1;
        return { state: "published" };
      },
    });
    expect(publishes).toBe(0);
  });

  it("requires inspected package ownership and an exact trusted publisher for OIDC", () => {
    const state = context();
    const authorization = record(structuredClone(state.authorization));
    record(record(authorization.packageAuthorities)["@pactmark/core"]).trustedPublisher = undefined;
    expect(() =>
      preparePublishPlan({
        mode: "public",
        registry: "https://registry.npmjs.org/",
        manifest: state.manifest,
        tarballDirectory: temporary,
        publicAuthorization: authorization as unknown as PublicAuthorization,
      }),
    ).toThrow("KAF_RELEASE_TRUSTED_PUBLISHER_UNVERIFIED");
  });

  it("preflights every package before performing the first write", () => {
    const first = context();
    const second = context({
      name: "create-pactmark",
      version: "0.1.0",
      publishConfig: { registry: "https://registry.npmjs.org/" },
    });
    first.manifest.status = "draft";
    first.manifest.metadataProfile = "local";
    const secondEntry = (second.manifest.packages as unknown[])[0];
    (first.manifest.packages as unknown[]).push(secondEntry);
    const plan = preparePublishPlan({
      mode: "loopback",
      registry: "http://127.0.0.1:4873/",
      manifest: first.manifest,
      tarballDirectory: temporary,
    });
    let inspections = 0;
    let publishes = 0;
    expect(() => {
      executePublishPlan(plan, {
        inspect: () => {
          inspections += 1;
          return inspections === 2 ? { state: "uncertain" } : { state: "absent" };
        },
        publish: () => {
          publishes += 1;
          return { state: "published" };
        },
      });
    }).toThrow("KAF_RELEASE_REGISTRY_STATE_UNCERTAIN");
    expect(inspections).toBe(2);
    expect(publishes).toBe(0);
  });
});
