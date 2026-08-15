import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

import type { PackedArtifact } from "../consumer/packed-artifacts.mjs";
import { readNpmPackedManifest } from "../lib/release-integrity.mjs";
import { sha256Bytes } from "../lib/release-integrity.mjs";
import { repositoryRoot } from "../lib/repository.mjs";
import {
  executePublishPlanAsync,
  preparePublishPlan,
  type PublishOperation,
  type PublishPlan,
  type RegistryInspection,
} from "../release-publish.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const RELEASE_VERSION = "0.2.0";

type JsonObject = Record<string, unknown>;

export interface LoopbackRegistry {
  readonly url: string;
  close(): Promise<void>;
}

export interface PublishedCandidate {
  readonly name: string;
  readonly version: string;
}

function candidateManifest(artifacts: readonly PackedArtifact[]): Readonly<{
  manifest: unknown;
  tarballDirectory: string;
}> {
  const tarballDirectory = dirname(artifacts[0]?.tarballPath ?? "");
  if (
    tarballDirectory.length === 0 ||
    artifacts.some((artifact) => dirname(artifact.tarballPath) !== tarballDirectory)
  )
    throw new Error("KAF_LOOPBACK_TARBALL_DIRECTORY_INVALID");
  return {
    tarballDirectory,
    manifest: {
      schemaVersion: "1",
      releaseVersion: RELEASE_VERSION,
      status: "local",
      metadataProfile: "local",
      packages: artifacts.map((artifact) => {
        const manifest = packedManifest(artifact);
        const dependencies: JsonObject = {};
        for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
          const value = manifest[field];
          if (value !== undefined)
            Object.assign(dependencies, object(value, "KAF_LOOPBACK_DEPENDENCIES_INVALID"));
        }
        return {
          name: artifact.name,
          version: artifact.version,
          directory: artifact.packageDirectory,
          tarball: basename(artifact.tarballPath),
          tarballSha256: artifact.sha256,
          dependencies,
        };
      }),
    },
  };
}

export function prepareCandidatePublishPlan(options: {
  readonly artifacts: readonly PackedArtifact[];
  readonly registryUrl: string;
}): PublishPlan {
  assertLoopbackRegistryUrl(options.registryUrl);
  const candidate = candidateManifest(options.artifacts);
  const plan = preparePublishPlan({
    mode: "loopback",
    registry: options.registryUrl,
    manifest: candidate.manifest,
    tarballDirectory: candidate.tarballDirectory,
  });
  if (plan.operations.some((operation) => operation.tag !== "candidate"))
    throw new Error("KAF_LOOPBACK_CANDIDATE_TAG_REQUIRED");
  if (plan.operations.at(-1)?.packageName !== "create-pactmark")
    throw new Error("KAF_LOOPBACK_INITIALIZER_NOT_LAST");
  return plan;
}

function object(value: unknown, code: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonObject;
}

function nonEmptyString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function assertLoopbackRegistryUrl(registryUrl: string): URL {
  const url = new URL(registryUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== LOOPBACK_HOST ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/"
  ) {
    throw new Error("KAF_LOOPBACK_REGISTRY_URL_INVALID");
  }
  return url;
}

function packedManifest(artifact: PackedArtifact): JsonObject {
  // Packed manifests are read from candidate bytes so dependency ordering is based on the
  // exact candidate bytes, never on workspace manifests containing workspace:*.
  return object(
    readNpmPackedManifest(readFileSync(artifact.tarballPath)),
    "KAF_LOOPBACK_MANIFEST_INVALID",
  );
}

function internalDependencies(
  artifact: PackedArtifact,
  candidateNames: ReadonlySet<string>,
): readonly string[] {
  const manifest = packedManifest(artifact);
  const dependencies = new Set<string>();
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const value = manifest[field];
    if (value === undefined) continue;
    for (const [name, version] of Object.entries(
      object(value, "KAF_LOOPBACK_DEPENDENCIES_INVALID"),
    )) {
      if (!candidateNames.has(name)) continue;
      if (version !== RELEASE_VERSION) throw new Error("KAF_LOOPBACK_DEPENDENCY_NOT_EXACT");
      dependencies.add(name);
    }
  }
  return [...dependencies].sort();
}

export function dependencyFirstCandidates(
  artifacts: readonly PackedArtifact[],
): readonly PackedArtifact[] {
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  if (byName.size !== artifacts.length) throw new Error("KAF_LOOPBACK_CANDIDATE_DUPLICATE");
  const candidateNames = new Set(byName.keys());
  const ordered: PackedArtifact[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error("KAF_LOOPBACK_DEPENDENCY_CYCLE");
    const artifact = byName.get(name);
    if (artifact === undefined) throw new Error("KAF_LOOPBACK_CANDIDATE_MISSING");
    visiting.add(name);
    for (const dependency of internalDependencies(artifact, candidateNames)) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(artifact);
  };

  for (const name of [...candidateNames].sort()) {
    if (name !== "create-pactmark") visit(name);
  }
  if (candidateNames.has("create-pactmark")) visit("create-pactmark");
  if (ordered.at(-1)?.name !== "create-pactmark") {
    throw new Error("KAF_LOOPBACK_INITIALIZER_NOT_LAST");
  }
  return ordered;
}

function npmEnvironment(options: {
  readonly root: string;
  readonly registryUrl: string;
}): NodeJS.ProcessEnv {
  assertLoopbackRegistryUrl(options.registryUrl);
  return {
    PATH: process.env["PATH"],
    NO_PROXY: `${LOOPBACK_HOST},localhost`,
    no_proxy: `${LOOPBACK_HOST},localhost`,
    npm_config_audit: "false",
    npm_config_cache: join(options.root, "npm-cache"),
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_provenance: "false",
    npm_config_registry: options.registryUrl,
    npm_config_update_notifier: "false",
    npm_config_userconfig: join(options.root, "npmrc"),
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, LOOPBACK_HOST, resolvePromise);
  });
  const address = probe.address();
  if (address === null || typeof address === "string") {
    probe.close();
    throw new Error("KAF_LOOPBACK_REGISTRY_ADDRESS_INVALID");
  }
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => {
    probe.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
  return port;
}

async function waitForRegistry(child: ChildProcess, registryUrl: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`KAF_LOOPBACK_REGISTRY_EXITED:${String(child.exitCode)}`);
    }
    try {
      const response = await fetch(new URL("-/ping", registryUrl), {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The child owns the port but has not completed plugin initialization yet.
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("KAF_LOOPBACK_REGISTRY_START_TIMEOUT");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => {
    child.once("exit", () => {
      resolvePromise();
    });
  });
  child.kill("SIGTERM");
  const terminated = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolvePromise) => {
      setTimeout(() => {
        resolvePromise(false);
      }, 5_000);
    }),
  ]);
  if (!terminated) {
    child.kill("SIGKILL");
    await exited;
  }
}

export async function startLoopbackRegistry(root: string): Promise<LoopbackRegistry> {
  const absoluteRoot = resolve(root);
  const storage = join(absoluteRoot, "storage");
  const authenticationFile = join(absoluteRoot, "htpasswd");
  const configurationPath = join(absoluteRoot, "verdaccio.yaml");
  await mkdir(storage, { recursive: true, mode: 0o700 });
  writeFileSync(join(absoluteRoot, "npmrc"), "", { mode: 0o600 });
  writeFileSync(
    configurationPath,
    [
      `storage: ${yamlString(storage)}`,
      "auth:",
      "  htpasswd:",
      `    file: ${yamlString(authenticationFile)}`,
      "    max_users: -1",
      "uplinks: {}",
      "packages:",
      "  '@*/*':",
      "    access: $all",
      "    publish: $all",
      "    unpublish: $all",
      "  '**':",
      "    access: $all",
      "    publish: $all",
      "    unpublish: $all",
      "middlewares:",
      "  audit:",
      "    enabled: false",
      "web:",
      "  enable: false",
      "log:",
      "  type: stdout",
      "  format: json",
      "  level: warn",
      "server:",
      "  keepAliveTimeout: 5",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const port = await reserveLoopbackPort();
  const url = `http://${LOOPBACK_HOST}:${String(port)}/`;
  assertLoopbackRegistryUrl(url);
  const child = spawn(
    join(repositoryRoot, "node_modules", ".bin", "verdaccio"),
    ["--config", configurationPath, "--listen", `${LOOPBACK_HOST}:${String(port)}`],
    {
      env: {
        PATH: process.env["PATH"],
        NO_PROXY: `${LOOPBACK_HOST},localhost`,
        no_proxy: `${LOOPBACK_HOST},localhost`,
      },
      stdio: "ignore",
    },
  );
  try {
    await waitForRegistry(child, url);
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  return {
    url,
    async close(): Promise<void> {
      await stopChild(child);
    },
  };
}

export async function publishCandidates(options: {
  readonly artifacts: readonly PackedArtifact[];
  readonly registryUrl: string;
  readonly root: string;
}): Promise<readonly PublishedCandidate[]> {
  assertLoopbackRegistryUrl(options.registryUrl);
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.root, "npmrc"), "", { mode: 0o600 });
  const plan = prepareCandidatePublishPlan({
    artifacts: options.artifacts,
    registryUrl: options.registryUrl,
  });
  const inspect = async (operation: PublishOperation): Promise<RegistryInspection> => {
    try {
      const response = await fetch(
        new URL(encodeURIComponent(operation.packageName), options.registryUrl),
        { signal: AbortSignal.timeout(5_000) },
      );
      if (response.status === 404) return { state: "absent" };
      if (!response.ok) return { state: "uncertain" };
      const metadata = object(await response.json(), "KAF_LOOPBACK_METADATA_INVALID");
      const versions = object(metadata["versions"], "KAF_LOOPBACK_VERSIONS_INVALID");
      const version = versions[operation.version];
      if (version === undefined) return { state: "absent" };
      const packed = object(version, "KAF_LOOPBACK_VERSION_METADATA_INVALID");
      const dist = object(packed["dist"], "KAF_LOOPBACK_DIST_INVALID");
      const tarball = nonEmptyString(dist["tarball"], "KAF_LOOPBACK_TARBALL_URL_INVALID");
      const tarballUrl = new URL(tarball);
      if (tarballUrl.origin !== new URL(options.registryUrl).origin) return { state: "uncertain" };
      const tarballResponse = await fetch(tarballUrl, { signal: AbortSignal.timeout(5_000) });
      if (!tarballResponse.ok) return { state: "uncertain" };
      return {
        state: "present",
        public: true,
        tarballSha256: sha256Bytes(new Uint8Array(await tarballResponse.arrayBuffer())),
      };
    } catch {
      return { state: "uncertain" };
    }
  };
  await executePublishPlanAsync(plan, {
    inspect,
    publish(operation) {
      try {
        return publishTarballToLoopback({
          tarballPath: operation.tarballPath,
          registryUrl: operation.registry,
          tag: operation.tag,
        }).then(
          (result) => ({
            state:
              result.name === operation.packageName && result.version === operation.version
                ? ("published" as const)
                : ("uncertain" as const),
          }),
          () => ({ state: "uncertain" as const }),
        );
      } catch {
        return Promise.resolve({ state: "uncertain" as const });
      }
    },
  });

  const published: PublishedCandidate[] = [];
  for (const operation of plan.operations) {
    const response = await fetch(
      new URL(encodeURIComponent(operation.packageName), options.registryUrl),
      {
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) throw new Error(`KAF_LOOPBACK_METADATA_MISSING:${operation.packageName}`);
    const metadata = object(await response.json(), "KAF_LOOPBACK_METADATA_INVALID");
    const versions = object(metadata["versions"], "KAF_LOOPBACK_VERSIONS_INVALID");
    if (versions[RELEASE_VERSION] === undefined) {
      throw new Error(`KAF_LOOPBACK_VERSION_MISSING:${operation.packageName}`);
    }
    const tags = object(metadata["dist-tags"], "KAF_LOOPBACK_TAGS_INVALID");
    if (tags["candidate"] !== RELEASE_VERSION)
      throw new Error(`KAF_LOOPBACK_CANDIDATE_TAG_INVALID:${operation.packageName}`);
    published.push({ name: operation.packageName, version: RELEASE_VERSION });
  }
  return published;
}

export async function publishTarballToLoopback(options: {
  readonly tarballPath: string;
  readonly registryUrl: string;
  readonly tag: "candidate" | "latest";
}): Promise<PublishedCandidate> {
  assertLoopbackRegistryUrl(options.registryUrl);
  const bytes = readFileSync(options.tarballPath);
  const manifest = object(readNpmPackedManifest(bytes), "KAF_LOOPBACK_TARBALL_MANIFEST_INVALID");
  const name = nonEmptyString(manifest["name"], "KAF_LOOPBACK_TARBALL_NAME_INVALID");
  const version = nonEmptyString(manifest["version"], "KAF_LOOPBACK_TARBALL_VERSION_INVALID");
  const filename = basename(options.tarballPath);
  const packageUrl = new URL(encodeURIComponent(name), options.registryUrl);
  const response = await fetch(packageUrl, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      _id: name,
      name,
      description: manifest["description"],
      "dist-tags": { [options.tag]: version },
      versions: {
        [version]: {
          ...manifest,
          _id: `${name}@${version}`,
          dist: {
            integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
            shasum: createHash("sha1").update(bytes).digest("hex"),
            tarball: new URL(`${encodeURIComponent(name)}/-/${filename}`, options.registryUrl).href,
          },
        },
      },
      _attachments: {
        [filename]: {
          content_type: "application/octet-stream",
          data: bytes.toString("base64"),
          length: bytes.byteLength,
        },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `KAF_LOOPBACK_PUBLISH_FAILED:${name}:${String(response.status)}:${(
        await response.text()
      ).slice(0, 1_000)}`,
    );
  }
  return { name, version };
}

export async function installFromLoopback(options: {
  readonly consumerDirectory: string;
  readonly registryUrl: string;
  readonly root: string;
}): Promise<void> {
  assertLoopbackRegistryUrl(options.registryUrl);
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.root, "npmrc"), "", { mode: 0o600 });
  execFileSync(
    "npm",
    [
      "install",
      "--registry",
      options.registryUrl,
      "--ignore-scripts",
      "--package-lock",
      "--save-exact",
    ],
    {
      cwd: options.consumerDirectory,
      encoding: "utf8",
      env: npmEnvironment({ root: options.root, registryUrl: options.registryUrl }),
      stdio: "pipe",
    },
  );
}

export const loopbackRegistryInternals = {
  assertLoopbackRegistryUrl,
  npmEnvironment,
};
