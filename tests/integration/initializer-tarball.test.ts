import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  packPublishablePackages,
  type PackedArtifact,
} from "../../tooling/consumer/packed-artifacts.mjs";

let root = "";
let initializer: PackedArtifact | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pactmark-initializer-tarball-"));
  const artifacts = await packPublishablePackages({
    destination: join(root, "tarballs"),
    npmCacheDirectory: join(root, "npm-pack-cache"),
  });
  initializer = artifacts.find(({ name }) => name === "create-pactmark");
}, 120_000);

afterAll(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

function executeInitializer(target: string, extraArguments: readonly string[]): string {
  if (initializer === undefined) throw new Error("KAF_TEST_INITIALIZER_TARBALL_MISSING");
  return execFileSync(
    "npm",
    [
      "exec",
      "--yes",
      "--offline",
      "--cache",
      join(root, "npm-exec-cache"),
      "--package",
      initializer.tarballPath,
      "--",
      "create-pactmark",
      target,
      "--template",
      "library",
      "--model",
      "mock-only",
      "--store",
      "memory",
      "--package-manager",
      "pnpm",
      "--yes",
      "--no-install",
      "--no-git",
      "--json",
      ...extraArguments,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

describe("initializer absolute tarball entrypoint", () => {
  it("executes dry-run without writing the target", () => {
    const output = executeInitializer("dry-agent", ["--dry-run"]);
    const result = JSON.parse(output) as {
      readonly created: boolean;
      readonly frameworkVersion: string;
      readonly targetPath: string;
      readonly dependencies: Readonly<Record<string, string>>;
    };
    expect(result.created).toBe(false);
    expect(result.frameworkVersion).toBe("0.2.0");
    expect(result.targetPath).toBe(join(realpathSync(root), "dry-agent"));
    expect(existsSync(result.targetPath)).toBe(false);
    expect(Object.values(result.dependencies).every((version) => version !== "latest")).toBe(true);
  });

  it("generates from the packed binary with exact framework versions and no workspace links", () => {
    const output = executeInitializer("generated-agent", []);
    const result = JSON.parse(output) as { readonly created: boolean; readonly targetPath: string };
    expect(result.created).toBe(true);
    const manifest = JSON.parse(readFileSync(join(result.targetPath, "package.json"), "utf8")) as {
      readonly dependencies: Readonly<Record<string, string>>;
      readonly devDependencies: Readonly<Record<string, string>>;
      readonly scripts: Readonly<Record<string, string>>;
    };
    const frameworkVersions = Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })
      .filter(([name]) => name.startsWith("@pactmark/"))
      .map(([, version]) => version);
    expect(frameworkVersions.length).toBeGreaterThan(0);
    expect(new Set(frameworkVersions)).toEqual(new Set(["0.2.0"]));
    expect(JSON.stringify(manifest)).not.toMatch(/(?:workspace:|latest)/u);
    expect(manifest.scripts.doctor).toBe("pactmark doctor --profile local");
  });
});
