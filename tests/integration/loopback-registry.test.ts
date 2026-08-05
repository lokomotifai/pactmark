import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  packPublishablePackages,
  type PackedArtifact,
} from "../../tooling/consumer/packed-artifacts.mjs";
import {
  dependencyFirstCandidates,
  installFromLoopback,
  loopbackRegistryInternals,
  publishCandidates,
  prepareCandidatePublishPlan,
  startLoopbackRegistry,
  type LoopbackRegistry,
  type PublishedCandidate,
} from "../../tooling/loopback-registry/candidate-registry.mjs";
import { repositoryRoot } from "../../tooling/lib/repository.mjs";

let root = "";
let artifacts: readonly PackedArtifact[] = [];
let published: readonly PublishedCandidate[] = [];
let registry: LoopbackRegistry | undefined;
let zodTarballPath = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pactmark-loopback-registry-"));
  const externalDirectory = join(root, "external-tarballs");
  const externalSource = join(root, "external-zod");
  await mkdir(externalDirectory, { recursive: true });
  cpSync(realpathSync(join(repositoryRoot, "node_modules", "zod")), externalSource, {
    recursive: true,
    dereference: true,
  });
  const externalPack = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        externalSource,
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        externalDirectory,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env["PATH"],
          npm_config_cache: join(root, "external-pack-cache"),
          npm_config_update_notifier: "false",
          npm_config_userconfig: join(root, "external-pack-npmrc"),
        },
      },
    ),
  ) as readonly {
    readonly filename: string;
    readonly files: readonly { readonly path: string }[];
  }[];
  const externalFilename = externalPack[0]?.filename;
  if (externalFilename === undefined) throw new Error("KAF_TEST_EXTERNAL_PACK_MISSING");
  if (!externalPack[0]?.files.some(({ path }) => path === "v4/core/json-schema.js")) {
    throw new Error("KAF_TEST_EXTERNAL_PACK_INCOMPLETE");
  }
  zodTarballPath = join(externalDirectory, externalFilename);
  artifacts = await packPublishablePackages({
    destination: join(root, "tarballs"),
    npmCacheDirectory: join(root, "npm-pack-cache"),
  });
  registry = await startLoopbackRegistry(join(root, "registry"));
  published = await publishCandidates({
    artifacts,
    registryUrl: registry.url,
    root: join(root, "publisher"),
  });
}, 180_000);

afterAll(async () => {
  await registry?.close();
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

describe("candidate loopback registry acceptance", () => {
  it("publishes all exact candidate tarballs dependency-first and the initializer last", () => {
    expect(artifacts).toHaveLength(19);
    expect(published).toHaveLength(artifacts.length);
    expect(published).toEqual(
      dependencyFirstCandidates(artifacts).map(({ name }) => ({ name, version: "0.1.1" })),
    );
    expect(published.at(-1)).toEqual({ name: "create-pactmark", version: "0.1.1" });
    if (registry === undefined) throw new Error("KAF_TEST_LOOPBACK_REGISTRY_MISSING");
    const plan = prepareCandidatePublishPlan({ artifacts, registryUrl: registry.url });
    expect(plan.mode).toBe("loopback");
    expect(new Set(plan.operations.map(({ tag }) => tag))).toEqual(new Set(["candidate"]));
    const position = new Map(published.map(({ name }, index) => [name, index]));
    expect(position.get("@pactmark/core") ?? -1).toBeLessThan(
      position.get("@pactmark/runtime") ?? -1,
    );
    expect(position.get("@pactmark/runtime") ?? -1).toBeLessThan(
      position.get("@pactmark/agent") ?? -1,
    );
    expect(position.get("@pactmark/agent") ?? -1).toBeLessThan(position.get("@pactmark/cli") ?? -1);

    const configuration = readFileSync(join(root, "registry", "verdaccio.yaml"), "utf8");
    expect(configuration).toContain("uplinks: {}");
    expect(configuration).toContain("publish: $all");
    expect(configuration).not.toContain("registry.npmjs.org");
  });

  it("fails closed before a publish or install can target a non-loopback registry", () => {
    for (const url of [
      "https://registry.npmjs.org/",
      "http://localhost:4873/",
      "http://127.0.0.1:4873/path",
      "http://token@127.0.0.1:4873/",
    ]) {
      expect(() => loopbackRegistryInternals.assertLoopbackRegistryUrl(url)).toThrow(
        "KAF_LOOPBACK_REGISTRY_URL_INVALID",
      );
    }
    if (registry === undefined) throw new Error("KAF_TEST_LOOPBACK_REGISTRY_MISSING");
    const environment = loopbackRegistryInternals.npmEnvironment({
      root: join(root, "environment-contract"),
      registryUrl: registry.url,
    });
    expect(Object.keys(environment).some((name) => /(?:auth|token|password)/iu.test(name))).toBe(
      false,
    );
    expect(environment["HOME"]).toBeUndefined();
  });

  it("installs and executes the exact initializer candidate without global npm config", async () => {
    if (registry === undefined) throw new Error("KAF_TEST_LOOPBACK_REGISTRY_MISSING");
    const consumer = join(root, "consumer");
    await mkdir(consumer, { recursive: true });
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify(
        {
          name: "pactmark-loopback-consumer",
          version: "1.0.0",
          private: true,
          dependencies: { "create-pactmark": "0.1.1" },
        },
        null,
        2,
      )}\n`,
    );
    await installFromLoopback({
      consumerDirectory: consumer,
      registryUrl: registry.url,
      root: join(root, "installer"),
    });

    const lockfile = readFileSync(join(consumer, "package-lock.json"), "utf8");
    expect(lockfile).toContain(`"resolved": "${registry.url}create-pactmark/-/`);
    expect(lockfile).toContain('"version": "0.1.1"');
    expect(lockfile).not.toContain("registry.npmjs.org");

    const target = join(consumer, "generated-agent");
    const output = execFileSync(
      join(consumer, "node_modules", ".bin", "create-pactmark"),
      [
        "generated-agent",
        "--template",
        "library",
        "--model",
        "mock-only",
        "--store",
        "memory",
        "--package-manager",
        "npm",
        "--yes",
        "--no-install",
        "--no-git",
        "--json",
      ],
      { cwd: consumer, encoding: "utf8", env: { PATH: process.env["PATH"] } },
    );
    const result = JSON.parse(output) as { readonly created: boolean };
    expect(result.created).toBe(true);
    expect(existsSync(target)).toBe(true);
    const generated = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as {
      readonly dependencies: Readonly<Record<string, string>>;
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const frameworkVersions = Object.entries({
      ...generated.dependencies,
      ...generated.devDependencies,
    })
      .filter(([name]) => name.startsWith("@pactmark/"))
      .map(([, version]) => version);
    expect(frameworkVersions.length).toBeGreaterThan(0);
    expect(new Set(frameworkVersions)).toEqual(new Set(["0.1.1"]));
    expect(JSON.stringify(generated)).not.toMatch(/(?:workspace:|latest)/u);
  }, 60_000);

  it("installs and imports the exact core candidate with independent Yarn and Bun consumers", async () => {
    if (registry === undefined) throw new Error("KAF_TEST_LOOPBACK_REGISTRY_MISSING");
    const core = artifacts.find(({ name }) => name === "@pactmark/core");
    if (core === undefined || zodTarballPath.length === 0) {
      throw new Error("KAF_TEST_LIBRARY_TARBALL_MISSING");
    }
    for (const packageManager of ["yarn", "bun"] as const) {
      const consumer = join(root, `${packageManager}-library-consumer`);
      const isolatedHome = join(root, `${packageManager}-home`);
      await mkdir(consumer, { recursive: true });
      await mkdir(isolatedHome, { recursive: true });
      writeFileSync(
        join(consumer, "package.json"),
        `${JSON.stringify(
          {
            name: `pactmark-${packageManager}-candidate-consumer`,
            version: "1.0.0",
            private: true,
            type: "module",
            packageManager: packageManager === "yarn" ? "yarn@4.18.0" : "bun@1.3.14",
            dependencies: {
              "@pactmark/core": `file:${core.tarballPath}`,
              zod: `file:${zodTarballPath}`,
            },
            resolutions: { zod: `file:${zodTarballPath}` },
            overrides: { zod: `file:${zodTarballPath}` },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(consumer, "smoke.mjs"),
        [
          'import * as core from "@pactmark/core";',
          'if (!("AgentDefinitionSchema" in core)) throw new Error("KAF_LIBRARY_EXPORT_MISSING");',
          'process.stdout.write("PACKED_LIBRARY_OK\\n");',
          "",
        ].join("\n"),
      );
      const environment: NodeJS.ProcessEnv = {
        PATH: process.env["PATH"],
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        npm_config_registry: registry.url,
        npm_config_update_notifier: "false",
        npm_config_userconfig: join(isolatedHome, "npmrc"),
      };
      writeFileSync(join(isolatedHome, "npmrc"), "", { mode: 0o600 });
      if (packageManager === "yarn") {
        writeFileSync(
          join(consumer, ".yarnrc.yml"),
          [
            "nodeLinker: node-modules",
            "enableScripts: false",
            "enableTelemetry: false",
            "enableGlobalCache: false",
            "npmMinimalAgeGate: 0",
            `npmRegistryServer: ${JSON.stringify(registry.url)}`,
            "unsafeHttpWhitelist:",
            "  - 127.0.0.1",
            "",
          ].join("\n"),
        );
        execFileSync(join(repositoryRoot, "node_modules", ".bin", "yarn"), ["install"], {
          cwd: consumer,
          encoding: "utf8",
          env: environment,
          stdio: "pipe",
        });
        const lockfile = readFileSync(join(consumer, "yarn.lock"), "utf8");
        expect(lockfile).toContain("pactmark-core-0.1.1.tgz");
        expect(lockfile).not.toContain("@pactmark/core@workspace:");
      } else {
        execFileSync(
          join(repositoryRoot, "node_modules", ".bin", "bun"),
          [
            "install",
            "--registry",
            registry.url,
            "--ignore-scripts",
            "--no-progress",
            "--no-summary",
          ],
          {
            cwd: consumer,
            encoding: "utf8",
            env: environment,
            stdio: "pipe",
          },
        );
        const lockfile = readFileSync(join(consumer, "bun.lock"), "utf8");
        expect(lockfile).toContain("pactmark-core-0.1.1.tgz");
        expect(lockfile).not.toContain("@pactmark/core@workspace:");
      }
      const output = execFileSync(process.execPath, [join(consumer, "smoke.mjs")], {
        cwd: consumer,
        encoding: "utf8",
        env: { PATH: process.env["PATH"] },
      });
      expect(output).toBe("PACKED_LIBRARY_OK\n");
    }
  }, 120_000);
});
