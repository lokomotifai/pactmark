import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { readNpmPackedManifest, sha256Bytes } from "../lib/release-integrity.mjs";
import { readJson, repositoryRoot } from "../lib/repository.mjs";

const RELEASE_VERSION = "0.1.1";
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
const SAFE_TOP_LEVEL_FILES = new Set(["LICENSE", "NOTICE", "README.md", "package.json"]);
const SAFE_DIRECTORY_PREFIXES = ["dist/", "migrations/"] as const;
const FORBIDDEN_PATH_COMPONENTS = new Set([
  ".env",
  "briefs",
  "coverage",
  "research",
  "src",
  "test",
  "tests",
]);

type JsonObject = Record<string, unknown>;

interface NpmPackFile {
  readonly path: string;
}

interface NpmPackResult {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly files: readonly NpmPackFile[];
  readonly shasum: string;
  readonly integrity: string;
}

function npmInvocation(args: readonly string[]): readonly [string, string[]] {
  if (process.platform !== "win32") return ["npm", [...args]];
  const npmCli = (process.env["PATH"] ?? "")
    .split(delimiter)
    .map((directory) => join(directory, "node_modules", "npm", "bin", "npm-cli.js"))
    .find((candidate) => existsSync(candidate));
  if (npmCli === undefined) throw new Error("KAF_PACK_NPM_CLI_NOT_FOUND");
  return [process.execPath, [npmCli, ...args]];
}

export interface PublishablePackage {
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly relativeDirectory: string;
  readonly manifest: JsonObject;
}

export interface NpmPackSnapshot {
  readonly name: string;
  readonly version: string;
  readonly files: readonly string[];
  readonly shasum: string;
  readonly integrity: string;
}

export interface PackedArtifact {
  readonly name: string;
  readonly version: string;
  readonly packageDirectory: string;
  readonly tarballPath: string;
  readonly sha256: string;
  readonly integrity: string;
  readonly files: readonly string[];
  readonly metadataWarnings: readonly string[];
}

function object(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonObject;
}

function string(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as JsonObject;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function packageDirectories(): readonly string[] {
  const packagesRoot = join(repositoryRoot, "packages");
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesRoot, entry.name))
    .filter((directory) => existsSync(join(directory, "package.json")))
    .filter(
      (directory) =>
        object(readJson(join(directory, "package.json")), "KAF_PACK_MANIFEST_INVALID").private !==
        true,
    )
    .sort();
}

export function discoverPublishablePackages(): readonly PublishablePackage[] {
  const packages = packageDirectories().map((directory) => {
    const manifest = object(readJson(join(directory, "package.json")), "KAF_PACK_MANIFEST_INVALID");
    return {
      name: string(manifest.name, "KAF_PACK_NAME_INVALID"),
      version: string(manifest.version, "KAF_PACK_VERSION_INVALID"),
      directory,
      relativeDirectory: relative(repositoryRoot, directory).replaceAll("\\", "/"),
      manifest,
    };
  });
  const names = packages.map(({ name }) => name);
  if (new Set(names).size !== names.length) throw new Error("KAF_PACK_DUPLICATE_PACKAGE");
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function validatePublishConfig(package_: PublishablePackage, manifest: JsonObject): void {
  const config = object(manifest.publishConfig, "KAF_PACK_PUBLISH_CONFIG_INVALID");
  if (config.registry !== PUBLIC_REGISTRY) throw new Error("KAF_PACK_REGISTRY_INVALID");
  if (package_.name.startsWith("@pactmark/") && config.access !== "public") {
    throw new Error("KAF_PACK_ACCESS_INVALID");
  }
  if (!package_.name.startsWith("@") && config.access !== undefined) {
    throw new Error("KAF_PACK_UNSCOPED_ACCESS_INVALID");
  }
}

function metadataWarnings(package_: PublishablePackage, manifest: JsonObject): readonly string[] {
  if (manifest.repository === undefined) return ["KAF_RELEASE_METADATA_PENDING"];
  const repository = object(manifest.repository, "KAF_PACK_REPOSITORY_INVALID");
  const url = string(repository.url, "KAF_PACK_REPOSITORY_INVALID");
  if (
    repository.type !== "git" ||
    !/^git\+https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\.git$/iu.test(url) ||
    /(?:example|placeholder|your[-_]?org)/iu.test(url)
  ) {
    throw new Error("KAF_PACK_REPOSITORY_INVALID");
  }
  if (repository.directory !== package_.relativeDirectory) {
    throw new Error("KAF_PACK_REPOSITORY_DIRECTORY_INVALID");
  }
  return [];
}

function validateDependencyVersions(manifest: JsonObject): void {
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ] as const) {
    if (manifest[field] === undefined) continue;
    for (const [name, value] of Object.entries(
      object(manifest[field], "KAF_PACK_DEPENDENCIES_INVALID"),
    )) {
      if (
        (name.startsWith("@pactmark/") || name === "create-pactmark") &&
        value !== RELEASE_VERSION
      ) {
        throw new Error("KAF_PACK_INTERNAL_DEPENDENCY_NOT_EXACT");
      }
    }
  }
}

function validatePackedManifest(
  package_: PublishablePackage,
  manifest: JsonObject,
): readonly string[] {
  if (manifest.name !== package_.name || manifest.version !== package_.version) {
    throw new Error("KAF_PACK_IDENTITY_DRIFT");
  }
  if (manifest.version !== RELEASE_VERSION) throw new Error("KAF_PACK_RELEASE_VERSION_INVALID");
  for (const field of [
    "name",
    "version",
    "description",
    "license",
    "type",
    "sideEffects",
    "files",
    "exports",
    "main",
    "types",
    "bin",
    "engines",
    "publishConfig",
    "repository",
  ] as const) {
    if (stable(manifest[field]) !== stable(package_.manifest[field])) {
      throw new Error(`KAF_PACK_MANIFEST_DRIFT:${field}`);
    }
  }
  if (manifest.license !== "Apache-2.0") throw new Error("KAF_PACK_LICENSE_INVALID");
  validatePublishConfig(package_, manifest);
  validateDependencyVersions(manifest);
  return metadataWarnings(package_, manifest);
}

export function validatePackedFiles(files: readonly string[]): readonly string[] {
  const normalized = [...files].map((path) => path.replaceAll("\\", "/")).sort();
  if (!normalized.includes("package.json")) throw new Error("KAF_PACK_MANIFEST_MISSING");
  for (const path of normalized) {
    if (path.startsWith("/") || path.includes("../") || path.includes("//")) {
      throw new Error(`KAF_PACK_PATH_INVALID:${path}`);
    }
    const components = path.split("/");
    const basename_ = components.at(-1) ?? "";
    if (
      components.some((component) => FORBIDDEN_PATH_COMPONENTS.has(component)) ||
      /^\.env(?:\.|$)/u.test(basename_) ||
      /\.(?:db|key|p12|pem|pfx|sqlite)$/u.test(basename_)
    ) {
      throw new Error(`KAF_PACK_PRIVATE_FILE:${path}`);
    }
    if (
      !SAFE_TOP_LEVEL_FILES.has(path) &&
      !SAFE_DIRECTORY_PREFIXES.some((prefix) => path.startsWith(prefix))
    ) {
      throw new Error(`KAF_PACK_FILE_NOT_ALLOWLISTED:${path}`);
    }
  }
  return normalized;
}

function npmPackResult(value: unknown): NpmPackResult {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("KAF_PACK_NPM_OUTPUT_INVALID");
  const entry = object(value[0], "KAF_PACK_NPM_OUTPUT_INVALID");
  if (!Array.isArray(entry.files)) throw new Error("KAF_PACK_NPM_FILES_INVALID");
  return {
    name: string(entry.name, "KAF_PACK_NPM_NAME_INVALID"),
    version: string(entry.version, "KAF_PACK_NPM_VERSION_INVALID"),
    filename: string(entry.filename, "KAF_PACK_NPM_FILENAME_INVALID"),
    files: entry.files.map((file) => ({
      path: string(object(file, "KAF_PACK_NPM_FILE_INVALID").path, "KAF_PACK_NPM_FILE_INVALID"),
    })),
    shasum: string(entry.shasum, "KAF_PACK_NPM_SHASUM_INVALID"),
    integrity: string(entry.integrity, "KAF_PACK_NPM_INTEGRITY_INVALID"),
  };
}

export function inspectNpmPack(
  package_: PublishablePackage,
  options: { readonly cacheDirectory: string },
): NpmPackSnapshot {
  const [command, args] = npmInvocation([
    "pack",
    "--json",
    "--dry-run",
    "--ignore-scripts",
    "--cache",
    options.cacheDirectory,
  ]);
  const output = execFileSync(command, args, { cwd: package_.directory, encoding: "utf8" });
  const result = npmPackResult(JSON.parse(output) as unknown);
  if (result.name !== package_.name || result.version !== package_.version) {
    throw new Error("KAF_PACK_NPM_IDENTITY_DRIFT");
  }
  return {
    name: result.name,
    version: result.version,
    files: validatePackedFiles(result.files.map(({ path }) => path)),
    shasum: result.shasum,
    integrity: result.integrity,
  };
}

function materializePublishManifest(package_: PublishablePackage): JsonObject {
  const manifest = structuredClone(package_.manifest);
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ] as const) {
    if (manifest[field] === undefined) continue;
    const dependencies = object(manifest[field], "KAF_PACK_DEPENDENCIES_INVALID");
    for (const [name, value] of Object.entries(dependencies)) {
      if (typeof value === "string" && value.startsWith("workspace:")) {
        if (!name.startsWith("@pactmark/") && name !== "create-pactmark") {
          throw new Error("KAF_PACK_EXTERNAL_WORKSPACE_DEPENDENCY");
        }
        dependencies[name] = RELEASE_VERSION;
      }
    }
  }
  return manifest;
}

function packDeterministicArtifact(
  package_: PublishablePackage,
  files: readonly string[],
  destination: string,
  npmCacheDirectory: string,
): NpmPackResult {
  const staging = mkdtempSync(join(tmpdir(), "pactmark-pack-stage-"));
  try {
    for (const path of files) {
      if (path === "package.json") continue;
      const source = join(package_.directory, path);
      const stats = lstatSync(source);
      if (!stats.isFile()) throw new Error(`KAF_PACK_NON_FILE:${path}`);
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      chmodSync(target, stats.mode & 0o777);
    }
    writeFileSync(
      join(staging, "package.json"),
      `${stable(materializePublishManifest(package_))}\n`,
      { mode: 0o644 },
    );
    const [command, args] = npmInvocation([
      "pack",
      ".",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      destination,
    ]);
    const output = execFileSync(command, args, {
      cwd: staging,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: npmCacheDirectory },
    });
    return npmPackResult(JSON.parse(output) as unknown);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function packPublishablePackages(options: {
  readonly destination: string;
  readonly npmCacheDirectory: string;
  readonly verifyNpmDeterminism?: boolean;
}): Promise<readonly PackedArtifact[]> {
  const destination = resolve(options.destination);
  if (!isAbsolute(destination)) throw new Error("KAF_PACK_DESTINATION_INVALID");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await mkdir(options.npmCacheDirectory, { recursive: true, mode: 0o700 });
  const artifacts: PackedArtifact[] = [];
  for (const package_ of discoverPublishablePackages()) {
    const first = inspectNpmPack(package_, { cacheDirectory: options.npmCacheDirectory });
    if (options.verifyNpmDeterminism === true) {
      const second = inspectNpmPack(package_, { cacheDirectory: options.npmCacheDirectory });
      if (stable(first) !== stable(second)) throw new Error("KAF_PACK_NPM_NONDETERMINISTIC");
    }
    const result = packDeterministicArtifact(
      package_,
      first.files,
      destination,
      options.npmCacheDirectory,
    );
    const tarballPath = resolve(destination, result.filename);
    const relativeTarball = relative(destination, tarballPath);
    if (relativeTarball.startsWith("..") || isAbsolute(relativeTarball)) {
      throw new Error("KAF_PACK_TARBALL_PATH_ESCAPE");
    }
    const files = validatePackedFiles(result.files.map(({ path }) => path));
    if (stable(files) !== stable(first.files)) throw new Error("KAF_PACK_FILE_LIST_DRIFT");
    const bytes = readFileSync(tarballPath);
    if (options.verifyNpmDeterminism === true) {
      const repeatDestination = mkdtempSync(join(tmpdir(), "pactmark-pack-repeat-"));
      try {
        const repeat = packDeterministicArtifact(
          package_,
          first.files,
          repeatDestination,
          options.npmCacheDirectory,
        );
        const repeatBytes = readFileSync(resolve(repeatDestination, repeat.filename));
        if (sha256Bytes(repeatBytes) !== sha256Bytes(bytes) || stable(repeat) !== stable(result)) {
          throw new Error("KAF_PACK_TARBALL_NONDETERMINISTIC");
        }
      } finally {
        rmSync(repeatDestination, { recursive: true, force: true });
      }
    }
    const packedManifest = object(readNpmPackedManifest(bytes), "KAF_PACK_PACKED_MANIFEST_INVALID");
    artifacts.push({
      name: package_.name,
      version: package_.version,
      packageDirectory: package_.relativeDirectory,
      tarballPath,
      sha256: sha256Bytes(bytes),
      integrity: result.integrity,
      files,
      metadataWarnings: validatePackedManifest(package_, packedManifest),
    });
  }
  return artifacts.sort((left, right) => left.name.localeCompare(right.name));
}

export function tarballDependencyMap(
  artifacts: readonly PackedArtifact[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...artifacts]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((artifact) => [artifact.name, `file:${artifact.tarballPath.replaceAll("\\", "/")}`]),
  );
}

export function assertNoWorkspaceResolution(consumerDirectory: string): void {
  const lockfile = readFileSync(join(consumerDirectory, "pnpm-lock.yaml"), "utf8");
  if (/\b(?:link|workspace):/u.test(lockfile))
    throw new Error("KAF_CONSUMER_WORKSPACE_LINK_DETECTED");
  if (!lockfile.includes(".tgz")) throw new Error("KAF_CONSUMER_TARBALL_MISSING");
}

export const packedArtifactInternals = {
  validatePackedManifest,
  validatePublishConfig,
  validateDependencyVersions,
  stable,
  publicRegistry: PUBLIC_REGISTRY,
  releaseVersion: RELEASE_VERSION,
};
