import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, readNpmPackedManifest, sha256Bytes } from "./lib/release-integrity.mjs";
import { gitFiles, gitSourceState, repositoryRoot, sha256File } from "./lib/repository.mjs";

type JsonRecord = Record<string, unknown>;

export type PublishMode = "loopback" | "public";

export interface PublicAuthorization {
  readonly authorized: true;
  readonly authMode: "oidc" | "interactive-bootstrap";
  readonly repository: string;
  readonly workflow: string;
  readonly publisherWorkflow: string;
  readonly ref: string;
  readonly environment: string;
  readonly runner: string;
  readonly tty: boolean;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly minimumNodeVersion: string;
  readonly minimumNpmVersion: string;
  readonly bootstrapUser?: string;
  readonly bootstrapOrganization?: string;
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
    "--ignore-scripts",
    ...(operation.access === "public" ? ["--access=public"] : []),
  ];
}

export interface PublicExecutionInput {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly sourceManifestPath: string;
  readonly authorizationFlag: string;
}

export interface PublicPublicationResult {
  readonly manifestDigest: string;
  readonly publishedPackages: number;
  readonly publication: "executed";
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
  atLeast(authorization.nodeVersion, "22.14.0", "KAF_RELEASE_NODE_FLOOR_UNMET");
  atLeast(authorization.npmVersion, "11.5.1", "KAF_RELEASE_NPM_FLOOR_UNMET");
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
          trusted.workflow !== authorization.publisherWorkflow ||
          trusted.environment !== authorization.environment ||
          trusted.runner !== authorization.runner
        ) {
          throw new Error("KAF_RELEASE_TRUSTED_PUBLISHER_MISMATCH");
        }
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

type FetchImplementation = typeof fetch;

function packageVersionUrl(operation: PublishOperation): URL {
  const base = new URL(operation.registry);
  const encodedName = encodeURIComponent(operation.packageName).replace("%40", "@");
  return new URL(`${encodedName}/${encodeURIComponent(operation.version)}`, base);
}

async function inspectPackagePresence(
  operation: PublishOperation,
  fetchImplementation: FetchImplementation,
): Promise<boolean | undefined> {
  try {
    const base = new URL(operation.registry);
    const encodedName = encodeURIComponent(operation.packageName).replace("%40", "@");
    const packageUrl = new URL(encodedName, base);
    packageUrl.searchParams.set("pactmark_authority_check", Date.now().toString());
    const response = await fetchImplementation(packageUrl, {
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 404) return false;
    if (response.ok) return true;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Inspect npm anonymously and hash the registry-served tarball, never local metadata alone. */
export async function inspectPublicRegistry(
  operation: PublishOperation,
  fetchImplementation: FetchImplementation = fetch,
): Promise<RegistryInspection> {
  try {
    const metadataUrl = packageVersionUrl(operation);
    metadataUrl.searchParams.set("pactmark_check", Date.now().toString());
    const metadataResponse = await fetchImplementation(metadataUrl, {
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
    });
    if (metadataResponse.status === 404) return { state: "absent" };
    if (!metadataResponse.ok) return { state: "uncertain" };
    const metadata = record(await metadataResponse.json(), "KAF_RELEASE_REGISTRY_METADATA_INVALID");
    if (metadata.name !== operation.packageName || metadata.version !== operation.version) {
      return { state: "uncertain" };
    }
    const dist = record(metadata.dist, "KAF_RELEASE_REGISTRY_DIST_INVALID");
    const tarballUrl = new URL(text(dist.tarball, "KAF_RELEASE_REGISTRY_TARBALL_INVALID"));
    if (tarballUrl.protocol !== "https:" || tarballUrl.hostname !== "registry.npmjs.org") {
      return { state: "uncertain" };
    }
    const tarballResponse = await fetchImplementation(tarballUrl, {
      cache: "no-store",
      redirect: "error",
    });
    if (!tarballResponse.ok) return { state: "uncertain" };
    return {
      state: "present",
      public: true,
      tarballSha256: sha256Bytes(Buffer.from(await tarballResponse.arrayBuffer())),
    };
  } catch {
    return { state: "uncertain" };
  }
}

function sourceFiles(sourceManifest: JsonRecord): readonly { path: string; digest: string }[] {
  if (!Array.isArray(sourceManifest.files) || sourceManifest.files.length === 0) {
    throw new Error("KAF_RELEASE_SOURCE_MANIFEST_FILES_INVALID");
  }
  return sourceManifest.files.map((value) => {
    const entry = record(value, "KAF_RELEASE_SOURCE_MANIFEST_ENTRY_INVALID");
    const path = text(entry.path, "KAF_RELEASE_SOURCE_MANIFEST_PATH_INVALID");
    if (!isSafeSourceManifestPath(path)) {
      throw new Error("KAF_RELEASE_SOURCE_MANIFEST_PATH_INVALID");
    }
    return {
      path,
      digest: text(entry.digest, "KAF_RELEASE_SOURCE_MANIFEST_DIGEST_INVALID"),
    };
  });
}

export function isSafeSourceManifestPath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\")) return false;
  return path
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Bind an executing public release to the exact clean source recorded by the candidate. */
export function verifyExecutingSource(manifest: unknown, sourceManifestPath: string): void {
  const releaseManifest = record(manifest, "KAF_RELEASE_MANIFEST_INVALID");
  const source = record(releaseManifest.source, "KAF_RELEASE_SOURCE_INVALID");
  const sourceManifest = record(
    JSON.parse(readFileSync(sourceManifestPath, "utf8")) as unknown,
    "KAF_RELEASE_SOURCE_MANIFEST_INVALID",
  );
  if (
    sourceManifest.profile !== "release" ||
    sourceManifest.publication !== "not_authorized" ||
    source.tree !== sha256Bytes(Buffer.from(canonicalJson(sourceManifest)))
  ) {
    throw new Error("KAF_RELEASE_SOURCE_MANIFEST_MISMATCH");
  }
  const state = gitSourceState(repositoryRoot);
  if (!state.clean || state.commit !== source.commit)
    throw new Error("KAF_RELEASE_EXECUTING_SOURCE_MISMATCH");
  const expected = sourceFiles(sourceManifest);
  const actualPaths = gitFiles()
    .filter((path) => !path.startsWith("briefs/") && !path.startsWith("research/"))
    .sort();
  if (canonicalJson(actualPaths) !== canonicalJson(expected.map(({ path }) => path).sort())) {
    throw new Error("KAF_RELEASE_EXECUTING_SOURCE_FILES_MISMATCH");
  }
  for (const entry of expected) {
    if (sha256File(resolve(repositoryRoot, entry.path)) !== entry.digest) {
      throw new Error("KAF_RELEASE_EXECUTING_SOURCE_DIGEST_MISMATCH");
    }
  }
}

function commandVersion(command: string): string {
  const result = spawnSync(command, ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) throw new Error("KAF_RELEASE_TOOLCHAIN_UNAVAILABLE");
  return result.stdout.trim();
}

function verifyInteractiveExecutionAuthorization(
  authorization: PublicAuthorization,
  releaseVersion: string,
  authorizationFlag: string,
): void {
  if (authorization.authMode !== "interactive-bootstrap") {
    throw new Error("KAF_RELEASE_EXECUTION_MODE_UNSUPPORTED");
  }
  if (authorizationFlag !== `publish-pactmark-${releaseVersion}`) {
    throw new Error("KAF_RELEASE_AUTHORIZATION_FLAG_INVALID");
  }
  if (process.env["CI"] !== undefined || process.env["GITHUB_ACTIONS"] !== undefined) {
    throw new Error("KAF_RELEASE_BOOTSTRAP_CI_FORBIDDEN");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || !authorization.tty) {
    throw new Error("KAF_RELEASE_INTERACTIVE_TTY_REQUIRED");
  }
  if (process.env["NODE_AUTH_TOKEN"] !== undefined || process.env["NPM_TOKEN"] !== undefined) {
    throw new Error("KAF_RELEASE_AUTOMATION_TOKEN_FORBIDDEN");
  }
  if (
    authorization.bootstrapUser === undefined ||
    authorization.bootstrapOrganization !== "pactmark"
  ) {
    throw new Error("KAF_RELEASE_BOOTSTRAP_IDENTITY_REQUIRED");
  }
  const actualNodeVersion = process.version.replace(/^v/u, "");
  const actualNpmVersion = commandVersion("npm");
  if (
    actualNodeVersion !== authorization.nodeVersion ||
    actualNpmVersion !== authorization.npmVersion
  ) {
    throw new Error("KAF_RELEASE_TOOLCHAIN_CONTEXT_MISMATCH");
  }
  const now = Date.now();
  for (const authority of Object.values(authorization.packageAuthorities)) {
    const inspectedAt = new Date(authority.inspectedAt).valueOf();
    if (!Number.isFinite(inspectedAt) || inspectedAt > now || now - inspectedAt > 15 * 60 * 1000) {
      throw new Error("KAF_RELEASE_PACKAGE_AUTHORITY_STALE");
    }
  }
}

function verifyOidcExecutionAuthorization(
  authorization: PublicAuthorization,
  releaseVersion: string,
  authorizationFlag: string,
): void {
  if (authorization.authMode !== "oidc") {
    throw new Error("KAF_RELEASE_EXECUTION_MODE_UNSUPPORTED");
  }
  if (authorizationFlag !== `publish-pactmark-${releaseVersion}`) {
    throw new Error("KAF_RELEASE_AUTHORIZATION_FLAG_INVALID");
  }
  if (
    process.env["CI"] !== "true" ||
    process.env["GITHUB_ACTIONS"] !== "true" ||
    authorization.tty ||
    process.stdin.isTTY ||
    process.stdout.isTTY
  ) {
    throw new Error("KAF_RELEASE_OIDC_GITHUB_HOST_REQUIRED");
  }
  if (process.env["NODE_AUTH_TOKEN"] !== undefined || process.env["NPM_TOKEN"] !== undefined) {
    throw new Error("KAF_RELEASE_AUTOMATION_TOKEN_FORBIDDEN");
  }
  const expectedWorkflowRef = `${authorization.repository}/${authorization.workflow}@${authorization.ref}`;
  if (
    process.env["GITHUB_REPOSITORY"] !== authorization.repository ||
    process.env["GITHUB_WORKFLOW_REF"] !== expectedWorkflowRef ||
    process.env["GITHUB_REF"] !== authorization.ref ||
    process.env["PACTMARK_RELEASE_ENVIRONMENT"] !== authorization.environment ||
    process.env["PACTMARK_RELEASE_RUNNER"] !== authorization.runner
  ) {
    throw new Error("KAF_RELEASE_OIDC_CONTEXT_INVALID");
  }
  if (
    process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] === undefined ||
    process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] === undefined
  ) {
    throw new Error("KAF_RELEASE_OIDC_TOKEN_UNAVAILABLE");
  }
  const actualNodeVersion = process.version.replace(/^v/u, "");
  const actualNpmVersion = commandVersion("npm");
  if (
    actualNodeVersion !== authorization.nodeVersion ||
    actualNpmVersion !== authorization.npmVersion
  ) {
    throw new Error("KAF_RELEASE_TOOLCHAIN_CONTEXT_MISMATCH");
  }
  const now = Date.now();
  for (const authority of Object.values(authorization.packageAuthorities)) {
    const inspectedAt = new Date(authority.inspectedAt).valueOf();
    if (!Number.isFinite(inspectedAt) || inspectedAt > now || now - inspectedAt > 15 * 60 * 1000) {
      throw new Error("KAF_RELEASE_PACKAGE_AUTHORITY_STALE");
    }
  }
}

function npmCommand(
  args: readonly string[],
  stdio: "inherit" | ["ignore", "pipe", "pipe"],
): ReturnType<typeof spawnSync> {
  return spawnSync("npm", [...args], {
    cwd: repositoryRoot,
    env: { ...process.env, npm_config_provenance: "false" },
    stdio,
    encoding: stdio === "inherit" ? undefined : "utf8",
    timeout: 15 * 60 * 1000,
  });
}

function npmOidcCommand(args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync("npm", [...args], {
    cwd: repositoryRoot,
    env: { ...process.env, npm_config_provenance: "true" },
    stdio: "inherit",
    timeout: 15 * 60 * 1000,
  });
}

function authenticatedNpmUser(registry: string): string | undefined {
  const result = npmCommand(["whoami", `--registry=${registry}`], ["ignore", "pipe", "pipe"]);
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const user = result.stdout.trim();
  return user.length > 0 ? user : undefined;
}

function loginForBootstrap(authorization: PublicAuthorization, registry: string): void {
  const expectedUser = authorization.bootstrapUser;
  if (expectedUser === undefined) throw new Error("KAF_RELEASE_BOOTSTRAP_IDENTITY_REQUIRED");
  const currentUser = authenticatedNpmUser(registry);
  if (currentUser !== undefined && currentUser !== expectedUser) {
    throw new Error("KAF_RELEASE_NPM_IDENTITY_MISMATCH");
  }
  if (currentUser === undefined) {
    const login = npmCommand(["login", "--auth-type=web", `--registry=${registry}`], "inherit");
    if (login.status !== 0) throw new Error("KAF_RELEASE_NPM_LOGIN_FAILED");
  }
  if (authenticatedNpmUser(registry) !== expectedUser) {
    if (currentUser === undefined) logoutBootstrap(registry);
    throw new Error("KAF_RELEASE_NPM_IDENTITY_MISMATCH");
  }
}

function logoutBootstrap(registry: string): void {
  const result = npmCommand(["logout", `--registry=${registry}`], "inherit");
  if (result.status !== 0) throw new Error("KAF_RELEASE_NPM_LOGOUT_FAILED");
}

export async function executeInteractiveBootstrap(
  plan: PublishPlan,
  authorization: PublicAuthorization,
  fetchImplementation: FetchImplementation = fetch,
): Promise<void> {
  const awaitingVisibility = new Set<string>();
  const initial = await Promise.all(
    plan.operations.map(async (operation) => ({
      operation,
      packagePresent: await inspectPackagePresence(operation, fetchImplementation),
      inspection: await inspectPublicRegistry(operation, fetchImplementation),
    })),
  );
  let missing = 0;
  for (const { operation, packagePresent, inspection } of initial) {
    const authority = authorization.packageAuthorities[operation.packageName];
    if (packagePresent === undefined) throw new Error("KAF_RELEASE_REGISTRY_STATE_UNCERTAIN");
    if (authority === undefined || packagePresent !== authority.packageExists) {
      throw new Error("KAF_RELEASE_PACKAGE_AUTHORITY_STALE");
    }
    if (inspection.state === "uncertain") throw new Error("KAF_RELEASE_REGISTRY_STATE_UNCERTAIN");
    if (inspection.state === "absent") {
      missing += 1;
      continue;
    }
    if (
      !inspection.public ||
      inspection.tarballSha256 !== sha256Bytes(readFileSync(operation.tarballPath))
    ) {
      throw new Error("KAF_RELEASE_EXISTING_BYTES_MISMATCH");
    }
  }
  if (missing === 0) return;
  const registry = plan.operations[0]?.registry ?? "https://registry.npmjs.org/";
  loginForBootstrap(authorization, registry);
  try {
    await executePublishPlanAsync(plan, {
      inspect: async (operation) => {
        const key = `${operation.packageName}@${operation.version}`;
        const attempts = awaitingVisibility.has(key) ? 10 : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const inspection = await inspectPublicRegistry(operation, fetchImplementation);
          if (inspection.state !== "absent" || attempt === attempts - 1) return inspection;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
        }
        return { state: "uncertain" };
      },
      publish: async (operation) => {
        const result = npmCommand(npmPublishArguments(operation), "inherit");
        if (result.status === 0) {
          awaitingVisibility.add(`${operation.packageName}@${operation.version}`);
          return { state: "published" };
        }
        const afterFailure = await inspectPublicRegistry(operation, fetchImplementation);
        if (
          afterFailure.state === "present" &&
          afterFailure.public &&
          afterFailure.tarballSha256 === sha256Bytes(readFileSync(operation.tarballPath))
        ) {
          return { state: "published" };
        }
        return { state: "uncertain" };
      },
    });
  } catch (error) {
    try {
      logoutBootstrap(registry);
    } catch (logoutError) {
      throw new AggregateError(
        [
          error instanceof Error ? error : new Error("KAF_RELEASE_PUBLICATION_FAILED"),
          logoutError instanceof Error ? logoutError : new Error("KAF_RELEASE_NPM_LOGOUT_FAILED"),
        ],
        "KAF_RELEASE_PUBLICATION_AND_LOGOUT_FAILED",
        { cause: logoutError },
      );
    }
    throw error instanceof Error ? error : new Error("KAF_RELEASE_PUBLICATION_FAILED");
  }
  logoutBootstrap(registry);
}

export async function executeOidcPublication(plan: PublishPlan): Promise<void> {
  const awaitingVisibility = new Set<string>();
  await executePublishPlanAsync(plan, {
    inspect: async (operation) => {
      const key = `${operation.packageName}@${operation.version}`;
      const attempts = awaitingVisibility.has(key) ? 10 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const inspection = await inspectPublicRegistry(operation);
        if (inspection.state !== "absent" || attempt === attempts - 1) return inspection;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
      }
      return { state: "uncertain" };
    },
    publish: async (operation) => {
      const result = npmOidcCommand(npmPublishArguments(operation));
      if (result.status === 0) {
        awaitingVisibility.add(`${operation.packageName}@${operation.version}`);
        return { state: "published" };
      }
      const afterFailure = await inspectPublicRegistry(operation);
      if (
        afterFailure.state === "present" &&
        afterFailure.public &&
        afterFailure.tarballSha256 === sha256Bytes(readFileSync(operation.tarballPath))
      ) {
        return { state: "published" };
      }
      return { state: "uncertain" };
    },
  });
}

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

export async function runReleasePublisher(
  argv: readonly string[],
): Promise<PublicPublicationResult> {
  if (argv.length !== 4 || argv[0] !== "--config" || argv[2] !== "--authorize-public-release") {
    throw new Error(
      "Usage: release-publish.mts --config <validated-local-config.json> --authorize-public-release <flag>",
    );
  }
  const configPath = argv[1];
  const authorizationFlag = argv[3];
  if (configPath === undefined || authorizationFlag === undefined) {
    throw new Error("KAF_RELEASE_CONFIG_REQUIRED");
  }
  const parsed = record(
    JSON.parse(readFileSync(configPath, "utf8")) as unknown,
    "KAF_RELEASE_CONFIG_INVALID",
  );
  if (parsed.execute !== true || parsed.mode !== "public") {
    throw new Error("KAF_RELEASE_PUBLIC_EXECUTION_REQUIRED");
  }
  const manifestPath = text(parsed.manifestPath, "KAF_RELEASE_MANIFEST_PATH_REQUIRED");
  const expectedManifestSha256 = text(
    parsed.manifestSha256,
    "KAF_RELEASE_MANIFEST_DIGEST_REQUIRED",
  );
  const manifestBytes = readFileSync(manifestPath);
  if (sha256Bytes(manifestBytes) !== expectedManifestSha256) {
    throw new Error("KAF_RELEASE_MANIFEST_DIGEST_MISMATCH");
  }
  const manifest = record(
    JSON.parse(manifestBytes.toString("utf8")) as unknown,
    "KAF_RELEASE_MANIFEST_INVALID",
  );
  const releaseVersion = text(manifest.releaseVersion, "KAF_RELEASE_VERSION_INVALID");
  const authorization = parsed.publicAuthorization as PublicAuthorization | undefined;
  if (authorization === undefined) throw new Error("KAF_RELEASE_EXTERNAL_AUTHORIZATION_REQUIRED");
  if (authorization.authMode === "oidc") {
    verifyOidcExecutionAuthorization(authorization, releaseVersion, authorizationFlag);
  } else {
    verifyInteractiveExecutionAuthorization(authorization, releaseVersion, authorizationFlag);
  }
  verifyExecutingSource(
    manifest,
    text(parsed.sourceManifestPath, "KAF_RELEASE_SOURCE_MANIFEST_REQUIRED"),
  );
  const plan = preparePublishPlan({
    mode: "public",
    registry: text(parsed.registry, "KAF_RELEASE_REGISTRY_INVALID"),
    manifest,
    tarballDirectory: text(parsed.tarballDirectory, "KAF_RELEASE_TARBALL_DIRECTORY_INVALID"),
    publicAuthorization: authorization,
  });
  if (authorization.authMode === "oidc") await executeOidcPublication(plan);
  else await executeInteractiveBootstrap(plan, authorization);
  return {
    manifestDigest: plan.manifestDigest,
    publishedPackages: plan.operations.length,
    publication: "executed",
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.length === 2) {
    const plan = runReleasePublisherDryRun(argv);
    process.stdout.write(`${canonicalJson({ ...plan, publication: "not_executed" })}\n`);
  } else {
    process.stdout.write(`${canonicalJson(await runReleasePublisher(argv))}\n`);
  }
}
