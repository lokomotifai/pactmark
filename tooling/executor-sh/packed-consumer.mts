import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { readNpmPackedManifest } from "../lib/release-integrity.mjs";
import { repositoryRoot } from "../lib/repository.mjs";

interface PackFile {
  readonly path: string;
}

interface PackResult {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly files: readonly PackFile[];
  readonly integrity: string;
}

const pnpmCliPath = join(repositoryRoot, "node_modules", "pnpm", "bin", "pnpm.mjs");

export class ExecutorPackedConsumerError extends Error {
  constructor(
    code: string,
    readonly safeDetail?: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ExecutorPackedConsumerError";
  }
}

function object(value: unknown, code: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as Readonly<Record<string, unknown>>;
}

function string(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function packResult(output: string): PackResult {
  const parsed = JSON.parse(output) as unknown;
  const value: unknown = Array.isArray(parsed) ? (parsed as readonly unknown[]).at(0) : parsed;
  const record = object(value, "KAF_EXECUTOR_PACK_OUTPUT_INVALID");
  if (!Array.isArray(record["files"])) throw new Error("KAF_EXECUTOR_PACK_OUTPUT_INVALID");
  return {
    name: string(record["name"], "KAF_EXECUTOR_PACK_OUTPUT_INVALID"),
    version: string(record["version"], "KAF_EXECUTOR_PACK_OUTPUT_INVALID"),
    filename: basename(string(record["filename"], "KAF_EXECUTOR_PACK_OUTPUT_INVALID")),
    files: record["files"].map((entry) => ({
      path: string(
        object(entry, "KAF_EXECUTOR_PACK_OUTPUT_INVALID")["path"],
        "KAF_EXECUTOR_PACK_OUTPUT_INVALID",
      ),
    })),
    integrity: "",
  };
}

function runPnpm(args: readonly string[], cwd = repositoryRoot): string {
  try {
    return execFileSync(process.execPath, [pnpmCliPath, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (cause) {
    const record =
      typeof cause === "object" && cause !== null
        ? (cause as { readonly stdout?: unknown; readonly stderr?: unknown })
        : {};
    const stdout = typeof record.stdout === "string" ? record.stdout : "";
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    const safeDetail = `${stdout}\n${stderr}`.trim().slice(0, 2_000);
    throw new ExecutorPackedConsumerError(
      "KAF_EXECUTOR_PNPM_COMMAND_FAILED",
      safeDetail.length === 0 ? undefined : safeDetail,
      { cause },
    );
  }
}

function validateExecutorFiles(files: readonly PackFile[]): readonly string[] {
  const normalized = files.map(({ path }) => path.replaceAll("\\", "/")).sort();
  if (
    !normalized.includes("package.json") ||
    !normalized.some((path) => path.startsWith("dist/"))
  ) {
    throw new Error("KAF_EXECUTOR_PACK_REQUIRED_FILE_MISSING");
  }
  for (const path of normalized) {
    if (
      path.startsWith("/") ||
      path.includes("../") ||
      (!path.startsWith("dist/") &&
        path !== "package.json" &&
        path !== "README.md" &&
        path !== "LICENSE" &&
        path !== "NOTICE") ||
      /(?:^|\/)(?:briefs|coverage|examples|research|src|test|tests)(?:\/|$)/u.test(path) ||
      /(?:^|\/)\.env(?:\.|$)/u.test(path) ||
      /\.(?:db|key|p12|pem|pfx|sqlite)$/u.test(path)
    ) {
      throw new Error(`KAF_EXECUTOR_PACK_PRIVATE_FILE:${path}`);
    }
  }
  return normalized;
}

function packPackage(
  packageName: "@pactmark/core" | "@pactmark/mcp" | "@pactmark/executor-sh",
  destination: string,
): Readonly<{ result: PackResult; tarballPath: string }> {
  const output = runPnpm([
    "--filter",
    packageName,
    "pack",
    "--json",
    "--pack-destination",
    destination,
  ]);
  const parsed = packResult(output);
  const tarballPath = resolve(destination, parsed.filename);
  const result = {
    ...parsed,
    integrity: `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`,
  };
  return { result, tarballPath };
}

function packedManifest(tarballPath: string): Readonly<Record<string, unknown>> {
  return object(
    readNpmPackedManifest(readFileSync(tarballPath)),
    "KAF_EXECUTOR_PACK_MANIFEST_INVALID",
  );
}

function assertPackedManifest(
  manifest: Readonly<Record<string, unknown>>,
  expectedName: string,
  expectedVersion: string,
): void {
  if (manifest["name"] !== expectedName || manifest["version"] !== expectedVersion) {
    throw new Error("KAF_EXECUTOR_PACK_IDENTITY_DRIFT");
  }
  if (expectedName !== "@pactmark/executor-sh") return;
  const dependencies = object(manifest["dependencies"], "KAF_EXECUTOR_PACK_DEPENDENCIES_INVALID");
  if (
    dependencies["@pactmark/core"] !== "0.1.1" ||
    dependencies["@pactmark/mcp"] !== "0.1.1" ||
    dependencies["zod"] !== "4.4.3" ||
    Object.values(dependencies).some(
      (value) => typeof value === "string" && /^(?:link|workspace):/u.test(value),
    )
  ) {
    throw new Error("KAF_EXECUTOR_PACK_DEPENDENCIES_INVALID");
  }
}

function smokeSource(): string {
  return `import {
  defineExecutorDeploymentProfile,
  defineExecutorSelfHostConformanceReceipt,
  executorSelfHostManifestDigest,
  verifyExecutorDeployment,
} from "@pactmark/executor-sh";

const observedAt = "2026-08-11T12:00:00.000Z";
const evaluatedAt = "2026-08-11T12:00:01.000Z";
const expiresAt = "2026-08-12T12:00:00.000Z";
const receipt = defineExecutorSelfHostConformanceReceipt({
  platform: "linux/amd64",
  containerRuntimeVersion: "packed-consumer",
  environmentDigest: executorSelfHostManifestDigest("linux/amd64"),
  observedAt,
  expiresAt,
  checks: {
    imagePinMatched: true,
    sourceRevisionMatched: true,
    mainProcessNonRoot: true,
    readOnlyRootFilesystem: true,
    capabilitiesDropped: true,
    noNewPrivileges: true,
    resourceLimitsApplied: true,
    dedicatedDataVolume: true,
    restartPersistence: true,
    backupRestore: true,
    telemetryDisabled: true,
    analyticsIdAbsent: true,
    outboundNetworkDenied: true,
    privateNetworkDenied: true,
    stdioMcpDisabled: true,
    bootstrapCompleted: true,
    unauthenticatedMcpDenied: true,
    apiKeyMcpAuthenticated: true,
    oauthPkceAuthenticated: true,
    crossTenantCredentialDenied: true,
    credentialCanariesAbsent: true,
    executeEnvelopeMatched: true,
  },
});
const profile = defineExecutorDeploymentProfile({
  tenantId: "packed-consumer-tenant",
  executorOrigin: "https://executor.example.invalid",
  opaqueConnectionRef: "credential-store/executor/main",
  backupPolicyId: "backup-policy/packed-consumer",
  receipt,
  evaluatedAt,
});
const verified = verifyExecutorDeployment(profile, receipt, evaluatedAt);
if (verified.profile.tenantId !== "packed-consumer-tenant") {
  throw new Error("KAF_EXECUTOR_PACKED_RUNTIME_FAILED");
}
process.stdout.write(JSON.stringify({ ok: true, node: process.versions.node }) + "\\n");
`;
}

function materializeConsumerLock(input: {
  readonly tarballs: string;
  readonly core: Readonly<{ result: PackResult }>;
  readonly mcp: Readonly<{ result: PackResult }>;
  readonly executor: Readonly<{ result: PackResult }>;
}): string {
  const template = readFileSync(
    join(repositoryRoot, "tests", "fixtures", "packed-consumer", "pnpm-lock.template.yaml"),
    "utf8",
  );
  const packagesMarker = "\npackages:\n";
  const snapshotsMarker = "\nsnapshots:\n";
  const packagesIndex = template.indexOf(packagesMarker);
  const snapshotsIndex = template.indexOf(snapshotsMarker);
  if (packagesIndex < 0 || snapshotsIndex < packagesIndex) {
    throw new Error("KAF_EXECUTOR_PACK_LOCK_TEMPLATE_INVALID");
  }
  const tarballRoot = input.tarballs.replaceAll("\\", "/");
  const coreSpecifier = `file:${tarballRoot}/${input.core.result.filename}`;
  const mcpSpecifier = `file:${tarballRoot}/${input.mcp.result.filename}`;
  const executorSpecifier = `file:${tarballRoot}/${input.executor.result.filename}`;
  const header = `lockfileVersion: "9.0"

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  "@pactmark/core": ${coreSpecifier}
  "@pactmark/mcp": ${mcpSpecifier}

importers:
  .:
    dependencies:
      "@pactmark/core":
        specifier: ${coreSpecifier}
        version: file:../tarballs/${input.core.result.filename}
      "@pactmark/executor-sh":
        specifier: ${executorSpecifier}
        version: file:../tarballs/${input.executor.result.filename}
      "@pactmark/mcp":
        specifier: ${mcpSpecifier}
        version: file:../tarballs/${input.mcp.result.filename}
`;
  const executorPackage = `
  "@pactmark/executor-sh@file:../tarballs/${input.executor.result.filename}":
    resolution:
      {
        integrity: ${input.executor.result.integrity},
        tarball: file:../tarballs/${input.executor.result.filename},
      }
    version: 0.1.0
    engines: { node: ^22.14.0 || ^24.0.0 }
`;
  const executorSnapshot = `
  "@pactmark/executor-sh@file:../tarballs/${input.executor.result.filename}":
    dependencies:
      "@pactmark/core": file:../tarballs/${input.core.result.filename}
      "@pactmark/mcp": file:../tarballs/${input.mcp.result.filename}
      zod: 4.4.3
`;
  const packagesAndSnapshots = template
    .slice(packagesIndex)
    .replace(packagesMarker, `${packagesMarker}${executorPackage}`)
    .replace(snapshotsMarker, `${snapshotsMarker}${executorSnapshot}`)
    .replaceAll("__PACTMARK_TARBALL_ROOT__", tarballRoot)
    .replaceAll("__PACTMARK_TARBALL_INTEGRITY_4__", input.core.result.integrity)
    .replaceAll("__PACTMARK_TARBALL_INTEGRITY_9__", input.mcp.result.integrity)
    .replace(/__PACTMARK_TARBALL_INTEGRITY_\d+__/gu, input.core.result.integrity);
  return `${header}${packagesAndSnapshots}`;
}

export interface ExecutorPackedConsumerResult {
  readonly schemaVersion: "1";
  readonly claim: "independent_tarball_consumer";
  readonly node: string;
  readonly executorVersion: "0.1.0";
  readonly coreVersion: "0.1.1";
  readonly mcpVersion: "0.1.1";
  readonly workspaceLinksAbsent: true;
  readonly runtimeSmokePassed: true;
  readonly cleanupVerified: true;
}

export async function runExecutorPackedConsumer(): Promise<ExecutorPackedConsumerResult> {
  const root = await mkdtemp(join(tmpdir(), "pactmark-executor-packed-consumer-"));
  let primaryError: unknown;
  let result: ExecutorPackedConsumerResult | undefined;
  try {
    const tarballs = join(root, "tarballs");
    const consumer = join(root, "consumer");
    await mkdir(tarballs, { recursive: true, mode: 0o700 });
    await mkdir(consumer, { recursive: true, mode: 0o700 });
    for (const packageName of [
      "@pactmark/core",
      "@pactmark/mcp",
      "@pactmark/executor-sh",
    ] as const) {
      runPnpm(["--filter", packageName, "build"]);
    }
    const core = packPackage("@pactmark/core", tarballs);
    const mcp = packPackage("@pactmark/mcp", tarballs);
    const executor = packPackage("@pactmark/executor-sh", tarballs);
    validateExecutorFiles(executor.result.files);
    assertPackedManifest(packedManifest(core.tarballPath), "@pactmark/core", "0.1.1");
    assertPackedManifest(packedManifest(mcp.tarballPath), "@pactmark/mcp", "0.1.1");
    assertPackedManifest(packedManifest(executor.tarballPath), "@pactmark/executor-sh", "0.1.0");
    const fileDependencies = {
      "@pactmark/core": `file:${core.tarballPath.replaceAll("\\", "/")}`,
      "@pactmark/mcp": `file:${mcp.tarballPath.replaceAll("\\", "/")}`,
      "@pactmark/executor-sh": `file:${executor.tarballPath.replaceAll("\\", "/")}`,
    };
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify(
        {
          name: "pactmark-executor-packed-consumer",
          version: "1.0.0",
          private: true,
          type: "module",
          dependencies: fileDependencies,
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(consumer, "pnpm-workspace.yaml"),
      `trustLockfile: true\nverifyDepsBeforeRun: false\nenableGlobalVirtualStore: false\noverrides:\n  "@pactmark/core": ${JSON.stringify(fileDependencies["@pactmark/core"])}\n  "@pactmark/mcp": ${JSON.stringify(fileDependencies["@pactmark/mcp"])}\n`,
    );
    writeFileSync(join(consumer, "smoke.mjs"), smokeSource());
    writeFileSync(
      join(consumer, "pnpm-lock.yaml"),
      materializeConsumerLock({ tarballs, core, mcp, executor }),
    );
    const storeDirectory = runPnpm(["store", "path"]).trim();
    runPnpm(
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--frozen-lockfile",
        "--store-dir",
        storeDirectory,
      ],
      consumer,
    );
    const lockfile = readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8");
    if (/\b(?:link|workspace):/u.test(lockfile) || !lockfile.includes(".tgz")) {
      throw new Error("KAF_EXECUTOR_PACK_WORKSPACE_LINK_DETECTED");
    }
    const runtime = execFileSync(process.execPath, [join(consumer, "smoke.mjs")], {
      cwd: consumer,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    const runtimeResult = object(
      JSON.parse(runtime.trim()) as unknown,
      "KAF_EXECUTOR_PACKED_RUNTIME_FAILED",
    );
    if (runtimeResult["ok"] !== true || runtimeResult["node"] !== process.versions.node) {
      throw new Error("KAF_EXECUTOR_PACKED_RUNTIME_FAILED");
    }
    result = Object.freeze({
      schemaVersion: "1",
      claim: "independent_tarball_consumer",
      node: process.versions.node,
      executorVersion: "0.1.0",
      coreVersion: "0.1.1",
      mcpVersion: "0.1.1",
      workspaceLinksAbsent: true,
      runtimeSmokePassed: true,
      cleanupVerified: true,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    await rm(root, { recursive: true, force: true });
    try {
      await access(root);
      primaryError ??= new Error("KAF_EXECUTOR_PACK_CLEANUP_FAILED");
    } catch {
      // Expected: the exact temporary fixture root was removed.
    }
  }
  if (primaryError !== undefined) {
    if (primaryError instanceof Error) throw primaryError;
    throw new Error("KAF_EXECUTOR_PACKED_CONSUMER_FAILED");
  }
  if (result === undefined) throw new Error("KAF_EXECUTOR_PACKED_CONSUMER_FAILED");
  return result;
}
