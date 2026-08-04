import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, readNpmPackedManifest, sha256Bytes } from "./lib/release-integrity.mjs";

type JsonRecord = Record<string, unknown>;

export type PublishMode = "loopback" | "public";

export interface PublicAuthorization {
  readonly authorized: true;
  readonly authMode: "oidc" | "interactive-bootstrap";
  readonly repository: string;
  readonly workflow: string;
  readonly ref: string;
  readonly environment: string;
  readonly runner: string;
  readonly tty: boolean;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly minimumNodeVersion: string;
  readonly minimumNpmVersion: string;
  readonly packageAuthorities: Readonly<
    Record<
      string,
      {
        readonly packageExists: boolean;
        readonly scopeOwned: boolean;
        readonly inspectedAt: string;
        readonly trustedPublisher?: {
          readonly repository: string;
          readonly workflow: string;
          readonly environment: string;
          readonly runner: "github-hosted";
        };
      }
    >
  >;
}

export interface PreparePublishInput {
  readonly mode: PublishMode;
  readonly registry: string;
  readonly manifest: unknown;
  readonly tarballDirectory: string;
  readonly publicAuthorization?: PublicAuthorization;
}

export interface PublishOperation {
  readonly packageName: string;
  readonly version: string;
  readonly tarballPath: string;
  readonly registry: string;
  readonly tag: "candidate" | "latest";
  readonly access?: "public";
}

export interface PublishPlan {
  readonly mode: PublishMode;
  readonly manifestDigest: string;
  readonly operations: readonly PublishOperation[];
}

export function npmPublishArguments(operation: PublishOperation): readonly string[] {
  return [
    "publish",
    operation.tarballPath,
    `--registry=${operation.registry}`,
    `--tag=${operation.tag}`,
    ...(operation.access === "public" ? ["--access=public"] : []),
  ];
}

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function publishMode(value: unknown): PublishMode {
  if (value !== "loopback" && value !== "public") throw new Error("KAF_RELEASE_MODE_INVALID");
  return value;
}

function versionParts(value: string, code: string): readonly number[] {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
  if (match === null) throw new Error(code);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: string, minimum: string, code: string): void {
  const left = versionParts(actual, code);
  const right = versionParts(minimum, code);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart > rightPart) return;
    if (leftPart < rightPart) throw new Error(code);
  }
}

function validateRegistry(mode: PublishMode, registry: string): void {
  let url: URL;
  try {
    url = new URL(registry);
  } catch {
    throw new Error("KAF_RELEASE_REGISTRY_INVALID");
  }
  if (mode === "loopback") {
    if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")) {
      throw new Error("KAF_RELEASE_LOOPBACK_REGISTRY_REQUIRED");
    }
    return;
  }
  if (url.href !== "https://registry.npmjs.org/")
    throw new Error("KAF_RELEASE_PUBLIC_REGISTRY_INVALID");
}

function publicAuthorization(
  manifest: JsonRecord,
  input: PreparePublishInput,
): PublicAuthorization {
  const authorization = input.publicAuthorization;
  if (authorization?.authorized !== true)
    throw new Error("KAF_RELEASE_EXTERNAL_AUTHORIZATION_REQUIRED");
  if (authorization.runner !== "github-hosted") throw new Error("KAF_RELEASE_RUNNER_INVALID");
  atLeast(
    authorization.nodeVersion,
    authorization.minimumNodeVersion,
    "KAF_RELEASE_NODE_FLOOR_UNMET",
  );
  atLeast(authorization.npmVersion, authorization.minimumNpmVersion, "KAF_RELEASE_NPM_FLOOR_UNMET");
  if (authorization.authMode === "interactive-bootstrap" && !authorization.tty) {
    throw new Error("KAF_RELEASE_INTERACTIVE_TTY_REQUIRED");
  }
  if (authorization.authMode === "oidc" && authorization.tty) {
    throw new Error("KAF_RELEASE_OIDC_NONINTERACTIVE_REQUIRED");
  }
  const attestation = record(manifest.attestation, "KAF_RELEASE_ATTESTATION_REQUIRED");
  for (const [field, expected] of [
    ["repository", authorization.repository],
    ["workflow", authorization.workflow],
    ["ref", authorization.ref],
    ["environment", authorization.environment],
    ["runner", authorization.runner],
  ] as const) {
    if (attestation[field] !== expected)
      throw new Error("KAF_RELEASE_ATTESTATION_CONTEXT_MISMATCH");
  }
  return authorization;
}

export function preparePublishPlan(input: PreparePublishInput): PublishPlan {
  validateRegistry(input.mode, input.registry);
  const manifest = record(input.manifest, "KAF_RELEASE_MANIFEST_INVALID");
  const releaseVersion = text(manifest.releaseVersion, "KAF_RELEASE_VERSION_INVALID");
  if (manifest.status === "abandoned") throw new Error("KAF_RELEASE_MANIFEST_ABANDONED");
  let authorization: PublicAuthorization | undefined;
  if (input.mode === "public") {
    if (manifest.status !== "attested") throw new Error("KAF_RELEASE_ATTESTED_MANIFEST_REQUIRED");
    if (manifest.metadataProfile !== "release")
      throw new Error("KAF_RELEASE_METADATA_PROFILE_INVALID");
    const source = record(manifest.source, "KAF_RELEASE_SOURCE_INVALID");
    if (source.clean !== true) throw new Error("KAF_RELEASE_DIRTY_SOURCE");
    authorization = publicAuthorization(manifest, input);
  } else if (manifest.metadataProfile !== "local") {
    throw new Error("KAF_RELEASE_LOCAL_METADATA_PROFILE_REQUIRED");
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error("KAF_RELEASE_PACKAGES_EMPTY");
  }
  const releaseNames = new Set<string>();
  const operations: PublishOperation[] = [];
  const dependenciesByName = new Map<string, readonly string[]>();
  for (const value of manifest.packages) {
    const entry = record(value, "KAF_RELEASE_PACKAGE_ENTRY_INVALID");
    const packageName = text(entry.name, "KAF_RELEASE_PACKAGE_NAME_INVALID");
    if (releaseNames.has(packageName)) throw new Error("KAF_RELEASE_DUPLICATE_PACKAGE");
    releaseNames.add(packageName);
    const version = text(entry.version, "KAF_RELEASE_PACKAGE_VERSION_INVALID");
    if (version !== releaseVersion) throw new Error("KAF_RELEASE_VERSION_MISMATCH");
    const tarballName = text(entry.tarball, "KAF_RELEASE_TARBALL_INVALID");
    if (tarballName.includes("/") || tarballName.includes("\\"))
      throw new Error("KAF_RELEASE_TARBALL_INVALID");
    const tarballPath = join(input.tarballDirectory, tarballName);
    const bytes = readFileSync(tarballPath);
    if (sha256Bytes(bytes) !== entry.tarballSha256)
      throw new Error("KAF_RELEASE_TARBALL_DIGEST_MISMATCH");
    const packed = record(readNpmPackedManifest(bytes), "KAF_RELEASE_PACKED_MANIFEST_INVALID");
    if (packed.name !== packageName || packed.version !== version) {
      throw new Error("KAF_RELEASE_PACKED_IDENTITY_MISMATCH");
    }
    const scoped = packageName.startsWith("@pactmark/");
    if (input.mode === "public") {
      if (authorization === undefined)
        throw new Error("KAF_RELEASE_EXTERNAL_AUTHORIZATION_REQUIRED");
      const packageAuthority = authorization.packageAuthorities[packageName];
      if (
        packageAuthority === undefined ||
        !packageAuthority.scopeOwned ||
        !Number.isFinite(new Date(packageAuthority.inspectedAt).valueOf())
      ) {
        throw new Error("KAF_RELEASE_PACKAGE_AUTHORITY_UNVERIFIED");
      }
      if (authorization.authMode === "oidc") {
        const trusted = packageAuthority.trustedPublisher;
        if (!packageAuthority.packageExists || trusted === undefined) {
          throw new Error("KAF_RELEASE_TRUSTED_PUBLISHER_UNVERIFIED");
        }
        if (
          trusted.repository !== authorization.repository ||
          trusted.workflow !== authorization.workflow ||
          trusted.environment !== authorization.environment ||
          trusted.runner !== authorization.runner
        ) {
          throw new Error("KAF_RELEASE_TRUSTED_PUBLISHER_MISMATCH");
        }
      } else if (packageAuthority.packageExists) {
        throw new Error("KAF_RELEASE_BOOTSTRAP_PACKAGE_ALREADY_EXISTS");
      }
      const directory = text(entry.directory, "KAF_RELEASE_DIRECTORY_INVALID");
      const repository = record(packed.repository, "KAF_RELEASE_PACKED_REPOSITORY_REQUIRED");
      if (
        repository.type !== "git" ||
        repository.url !== `git+https://github.com/${authorization.repository}.git`
      ) {
        throw new Error("KAF_RELEASE_PACKED_REPOSITORY_INVALID");
      }
      if (repository.directory !== directory)
        throw new Error("KAF_RELEASE_PACKED_DIRECTORY_MISMATCH");
      const publishConfig = record(packed.publishConfig, "KAF_RELEASE_PUBLISH_CONFIG_REQUIRED");
      if (publishConfig.registry !== "https://registry.npmjs.org/") {
        throw new Error("KAF_RELEASE_PACKED_REGISTRY_INVALID");
      }
      if (scoped && publishConfig.access !== "public")
        throw new Error("KAF_RELEASE_SCOPED_ACCESS_INVALID");
      if (!scoped && publishConfig.access !== undefined)
        throw new Error("KAF_RELEASE_UNSCOPED_ACCESS_INVALID");
    }
    operations.push({
      packageName,
      version,
      tarballPath,
      registry: input.registry,
      tag: input.mode === "loopback" ? "candidate" : "latest",
      ...(scoped ? { access: "public" as const } : {}),
    });
  }
  for (const value of manifest.packages) {
    const entry = record(value, "KAF_RELEASE_PACKAGE_ENTRY_INVALID");
    const dependencies = record(entry.dependencies ?? {}, "KAF_RELEASE_DEPENDENCIES_INVALID");
    const entryName = text(entry.name, "KAF_RELEASE_PACKAGE_NAME_INVALID");
    dependenciesByName.set(
      entryName,
      Object.keys(dependencies)
        .filter((name) => releaseNames.has(name))
        .sort(),
    );
    for (const [name, version] of Object.entries(dependencies)) {
      if (releaseNames.has(name) && version !== releaseVersion) {
        throw new Error("KAF_RELEASE_INTERNAL_DEPENDENCY_NOT_EXACT");
      }
    }
  }
  const operationByName = new Map(
    operations.map((operation) => [operation.packageName, operation]),
  );
  const ordered: PublishOperation[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error("KAF_RELEASE_INTERNAL_DEPENDENCY_CYCLE");
    visiting.add(name);
    for (const dependency of dependenciesByName.get(name) ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    const operation = operationByName.get(name);
    if (operation === undefined) throw new Error("KAF_RELEASE_OPERATION_MISSING");
    ordered.push(operation);
  };
  for (const name of [...releaseNames].filter((name) => name !== "create-pactmark").sort())
    visit(name);
  if (releaseNames.has("create-pactmark")) visit("create-pactmark");
  return {
    mode: input.mode,
    manifestDigest: sha256Bytes(Buffer.from(canonicalJson(manifest))),
    operations: ordered,
  };
}

export type RegistryInspection =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly public: boolean; readonly tarballSha256: string }
  | { readonly state: "uncertain" };

export interface PublishExecutor {
  inspect(operation: PublishOperation): RegistryInspection;
  publish(operation: PublishOperation): { readonly state: "published" | "uncertain" };
}

export interface AsyncPublishExecutor {
  inspect(operation: PublishOperation): Promise<RegistryInspection>;
  publish(operation: PublishOperation): Promise<{ readonly state: "published" | "uncertain" }>;
}

export function executePublishPlan(plan: PublishPlan, executor: PublishExecutor): void {
  const preflight = plan.operations.map((operation) => ({
    operation,
    before: executor.inspect(operation),
  }));
  for (const { operation, before } of preflight) {
    if (before.state === "uncertain") throw new Error("KAF_RELEASE_REGISTRY_STATE_UNCERTAIN");
    if (before.state === "present") {
      if (
        !before.public ||
        before.tarballSha256 !== sha256Bytes(readFileSync(operation.tarballPath))
      ) {
        throw new Error("KAF_RELEASE_EXISTING_BYTES_MISMATCH");
      }
    }
  }
  for (const { operation, before } of preflight) {
    if (before.state === "present") continue;
    const result = executor.publish(operation);
    if (result.state === "uncertain") {
      throw new Error("KAF_RELEASE_PUBLISH_UNCERTAIN_NO_RETRY");
    }
    const after = executor.inspect(operation);
    if (after.state !== "present" || !after.public)
      throw new Error("KAF_RELEASE_POST_PUBLISH_UNVERIFIED");
    if (after.tarballSha256 !== sha256Bytes(readFileSync(operation.tarballPath))) {
      throw new Error("KAF_RELEASE_POST_PUBLISH_DIGEST_MISMATCH");
    }
  }
}

/** Async equivalent used by isolated registry acceptance tests and network-backed publishers. */
export async function executePublishPlanAsync(
  plan: PublishPlan,
  executor: AsyncPublishExecutor,
): Promise<void> {
  const preflight = await Promise.all(
    plan.operations.map(async (operation) => ({
      operation,
      before: await executor.inspect(operation),
    })),
  );
  for (const { operation, before } of preflight) {
    if (before.state === "uncertain") throw new Error("KAF_RELEASE_REGISTRY_STATE_UNCERTAIN");
    if (before.state === "present") {
      if (
        !before.public ||
        before.tarballSha256 !== sha256Bytes(readFileSync(operation.tarballPath))
      ) {
        throw new Error("KAF_RELEASE_EXISTING_BYTES_MISMATCH");
      }
    }
  }
  for (const { operation, before } of preflight) {
    if (before.state === "present") continue;
    const result = await executor.publish(operation);
    if (result.state === "uncertain") throw new Error("KAF_RELEASE_PUBLISH_UNCERTAIN_NO_RETRY");
    const after = await executor.inspect(operation);
    if (after.state !== "present" || !after.public)
      throw new Error("KAF_RELEASE_POST_PUBLISH_UNVERIFIED");
    if (after.tarballSha256 !== sha256Bytes(readFileSync(operation.tarballPath))) {
      throw new Error("KAF_RELEASE_POST_PUBLISH_DIGEST_MISMATCH");
    }
  }
}

export function runReleasePublisherDryRun(argv: readonly string[]): PublishPlan {
  if (argv.length !== 2 || argv[0] !== "--config") {
    throw new Error("Usage: release-publish.mts --config <validated-local-config.json>");
  }
  const configPath = argv[1];
  if (configPath === undefined) throw new Error("KAF_RELEASE_CONFIG_REQUIRED");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  const parsed = record(config, "KAF_RELEASE_CONFIG_INVALID");
  if (parsed.execute !== false) throw new Error("KAF_RELEASE_DRY_RUN_ONLY");
  return preparePublishPlan({
    mode: publishMode(parsed.mode),
    registry: text(parsed.registry, "KAF_RELEASE_REGISTRY_INVALID"),
    manifest: parsed.manifest,
    tarballDirectory: text(parsed.tarballDirectory, "KAF_RELEASE_TARBALL_DIRECTORY_INVALID"),
    ...(parsed.publicAuthorization === undefined
      ? {}
      : { publicAuthorization: parsed.publicAuthorization as PublicAuthorization }),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = runReleasePublisherDryRun(process.argv.slice(2));
  process.stdout.write(`${canonicalJson({ ...plan, publication: "not_executed" })}\n`);
}
