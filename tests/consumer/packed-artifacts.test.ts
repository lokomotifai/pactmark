import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertNoWorkspaceResolution,
  discoverPublishablePackages,
  inspectNpmPack,
  packPublishablePackages,
  packedArtifactInternals,
  tarballDependencyMap,
  validatePackedFiles,
  type PackedArtifact,
} from "../../tooling/consumer/packed-artifacts.mjs";
import { repositoryRoot } from "../../tooling/lib/repository.mjs";

let root = "";
let artifacts: readonly PackedArtifact[] = [];
const pnpmCliPath = join(repositoryRoot, "node_modules", "pnpm", "bin", "pnpm.mjs");
const pnpmStoreDirectory =
  process.env["PACTMARK_PNPM_STORE"] ??
  execFileSync(process.execPath, [pnpmCliPath, "store", "path"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
const lockTemplatePath = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "packed-consumer",
  "pnpm-lock.template.yaml",
);
const tarballRootPlaceholder = "__PACTMARK_TARBALL_ROOT__";
const externalOverrides = {
  jose: "6.2.7",
} as const;
const packedArtifactTimeout = process.platform === "win32" ? 300_000 : 120_000;
const packedArtifactCleanupTimeout = process.platform === "win32" ? 60_000 : 30_000;
const npmPackObservationTimeout = process.platform === "win32" ? 30_000 : 5_000;

function materializeLockTemplate(template: string): string {
  let lockfile = template.replaceAll(
    tarballRootPlaceholder,
    join(root, "tarballs").replaceAll("\\", "/"),
  );
  for (const [index, artifact] of artifacts.entries()) {
    const placeholder = `__PACTMARK_TARBALL_INTEGRITY_${String(index)}__`;
    expect(lockfile).toContain(placeholder);
    lockfile = lockfile.replaceAll(placeholder, artifact.integrity);
  }
  expect(lockfile).not.toContain("__PACTMARK_TARBALL_INTEGRITY_");
  return lockfile;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pactmark-packed-consumer-"));
  artifacts = await packPublishablePackages({
    destination: join(root, "tarballs"),
    npmCacheDirectory: join(root, "npm-cache"),
    verifyNpmDeterminism: true,
  });
}, packedArtifactTimeout);

afterAll(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
}, packedArtifactCleanupTimeout);

function packageImportSource(): string {
  return artifacts
    .map(
      ({ name }, index) =>
        `import * as package${String(index)} from ${JSON.stringify(name)};\n` +
        `if (Object.keys(package${String(index)}).length === 0) throw new Error(${JSON.stringify(
          `KAF_CONSUMER_EMPTY_EXPORT:${name}`,
        )});`,
    )
    .join("\n");
}

async function makeConsumer(
  name: string,
  moduleResolution: "NodeNext" | "Bundler",
): Promise<string> {
  const directory = join(root, name);
  await mkdir(join(directory, "src"), { recursive: true });
  const module = moduleResolution === "NodeNext" ? "NodeNext" : "ESNext";
  const tarballs = tarballDependencyMap(artifacts);
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name,
        version: "1.0.0",
        private: true,
        type: "module",
        dependencies: {
          ...tarballs,
          ai: "7.0.48",
          typescript: "6.0.3",
          "@types/json-schema": "7.0.15",
          "@types/node": "22.20.1",
          "@types/pg": "8.20.0",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(directory, "pnpm-workspace.yaml"),
    `trustLockfile: true\nenableGlobalVirtualStore: false\ndedupeInjectedDeps: false\noverrides:\n${Object.entries(
      { ...tarballs, ...externalOverrides },
    )
      .map(
        ([packageName, tarball]) => `  ${JSON.stringify(packageName)}: ${JSON.stringify(tarball)}`,
      )
      .join("\n")}\n`,
  );
  const lockTemplate = readFileSync(lockTemplatePath, "utf8");
  expect(lockTemplate).toContain(tarballRootPlaceholder);
  writeFileSync(join(directory, "pnpm-lock.yaml"), materializeLockTemplate(lockTemplate));
  writeFileSync(
    join(directory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2023",
          module,
          moduleResolution,
          noEmit: moduleResolution === "Bundler",
          outDir: "dist",
          rootDir: "src",
          skipLibCheck: false,
          types: ["node"],
          verbatimModuleSyntax: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(directory, "src", "index.ts"),
    `${packageImportSource()}\nprocess.stdout.write("PACKED_EXPORTS_OK\\n");\n`,
  );
  try {
    execFileSync(
      process.execPath,
      [
        pnpmCliPath,
        "install",
        "--offline",
        "--ignore-scripts",
        "--frozen-lockfile",
        "--store-dir",
        pnpmStoreDirectory,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch (error) {
    const output =
      typeof error === "object" && error !== null && "stderr" in error
        ? `${"stdout" in error ? String(error.stdout) : ""}\n${String(error.stderr)}`
        : "KAF_CONSUMER_INSTALL_STDERR_UNAVAILABLE";
    throw new Error(`KAF_CONSUMER_INSTALL_FAILED\n${output}`, { cause: error });
  }
  return directory;
}

describe("packed artifact acceptance", () => {
  it("keeps every external consumer tarball in the root installation authority", () => {
    const rootLock = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
    const fixtureLock = readFileSync(lockTemplatePath, "utf8");
    const rootIntegrities = new Set(
      [...rootLock.matchAll(/integrity: ([A-Za-z0-9+/=_-]+)/gu)].map((match) => match[1]),
    );
    const fixtureIntegrities = [...fixtureLock.matchAll(/integrity: ([A-Za-z0-9+/=_-]+)/gu)]
      .map((match) => match[1])
      .filter((integrity) => !integrity?.startsWith("__PACTMARK_TARBALL_INTEGRITY_"));
    expect(fixtureIntegrities.every((integrity) => rootIntegrities.has(integrity))).toBe(true);
  });

  it("validates every publishable npm pack file list and exact packed metadata", () => {
    const packages = discoverPublishablePackages();
    expect(artifacts).toHaveLength(packages.length);
    expect(artifacts.length).toBeGreaterThanOrEqual(19);
    expect(artifacts.map(({ name }) => name)).toEqual(packages.map(({ name }) => name));
    for (const artifact of artifacts) {
      expect(artifact.version).toBe(packedArtifactInternals.releaseVersion);
      expect(artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(artifact.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/u);
      expect(artifact.files).toContain("package.json");
      expect(artifact.files.some((path) => path.startsWith("dist/"))).toBe(true);
      expect(artifact.metadataWarnings).toEqual([]);
      expect(artifact.tarballPath.startsWith(join(root, "tarballs"))).toBe(true);
    }
  });

  it("rejects private, source, and unallowlisted npm tarball paths", () => {
    for (const path of [
      ".env",
      ".env.production",
      "briefs/private.md",
      "research/input.md",
      "src/index.ts",
      "tests/runtime.test.js",
      "coverage/index.html",
      "secret.pem",
    ]) {
      expect(() => validatePackedFiles(["package.json", path])).toThrow(/KAF_PACK_/u);
    }
  });

  it("rejects wrong registry and scoped access metadata before any registry write", () => {
    const core = discoverPublishablePackages().find(({ name }) => name === "@pactmark/core");
    const initializer = discoverPublishablePackages().find(
      ({ name }) => name === "create-pactmark",
    );
    expect(core).toBeDefined();
    expect(initializer).toBeDefined();
    if (core === undefined || initializer === undefined) return;
    expect(() => {
      packedArtifactInternals.validatePublishConfig(core, {
        publishConfig: { registry: "https://registry.example.invalid/", access: "public" },
      });
    }).toThrow("KAF_PACK_REGISTRY_INVALID");
    expect(() => {
      packedArtifactInternals.validatePublishConfig(core, {
        publishConfig: {
          registry: packedArtifactInternals.publicRegistry,
          access: "restricted",
        },
      });
    }).toThrow("KAF_PACK_ACCESS_INVALID");
    expect(() => {
      packedArtifactInternals.validatePublishConfig(initializer, {
        publishConfig: { registry: packedArtifactInternals.publicRegistry, access: "public" },
      });
    }).toThrow("KAF_PACK_UNSCOPED_ACCESS_INVALID");
  });

  it(
    "observes stable npm pack --json output for an independently selected package",
    () => {
      const core = discoverPublishablePackages().find(({ name }) => name === "@pactmark/core");
      expect(core).toBeDefined();
      if (core === undefined) return;
      const first = inspectNpmPack(core, { cacheDirectory: join(root, "npm-cache") });
      const second = inspectNpmPack(core, { cacheDirectory: join(root, "npm-cache") });
      expect(second).toEqual(first);
    },
    npmPackObservationTimeout,
  );

  it(
    "installs absolute tarballs into independent NodeNext and Bundler consumers",
    async () => {
      for (const resolution of ["NodeNext", "Bundler"] as const) {
        const consumer = await makeConsumer(`consumer-${resolution.toLowerCase()}`, resolution);
        assertNoWorkspaceResolution(consumer);
        const installedCore = join(consumer, "node_modules", "@pactmark", "core");
        expect(lstatSync(installedCore).isSymbolicLink()).toBe(true);
        const relativeToWorkspace = relative(
          join(repositoryRoot, "packages"),
          realpathSync(installedCore),
        );
        expect(
          isAbsolute(relativeToWorkspace) ||
            relativeToWorkspace === ".." ||
            relativeToWorkspace.startsWith(`..${sep}`),
        ).toBe(true);
        execFileSync(
          process.execPath,
          [join(consumer, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
          {
            cwd: consumer,
            encoding: "utf8",
            stdio: "pipe",
          },
        );
        if (resolution === "NodeNext") {
          const output = execFileSync(process.execPath, [join(consumer, "dist", "index.js")], {
            cwd: consumer,
            encoding: "utf8",
          });
          expect(output).toBe("PACKED_EXPORTS_OK\n");
        }
        const lockfile = readFileSync(join(consumer, "pnpm-lock.yaml"), "utf8");
        expect(lockfile).toContain(".tgz");
        expect(lockfile).not.toContain("workspace:");
      }
    },
    packedArtifactTimeout,
  );
});
