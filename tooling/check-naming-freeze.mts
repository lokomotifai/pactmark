import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { gitFiles, readJson, repositoryRoot } from "./lib/repository.mjs";

type PackageManifest = Readonly<{
  name?: unknown;
  private?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  publishConfig?: Readonly<{ access?: unknown; registry?: unknown }>;
  repository?: unknown;
}>;

const expectedRepositoryUrl = "git+https://github.com/pactmark/pactmark.git";

const failures: string[] = [];
const files = gitFiles();
const lowercasePaths = new Map<string, string>();

for (const path of files) {
  const key = path.toLocaleLowerCase("en-US");
  const existing = lowercasePaths.get(key);
  if (existing !== undefined && existing !== path) {
    failures.push(`KAF_NAMING_PATH_CASE_COLLISION:${existing}:${path}`);
  } else {
    lowercasePaths.set(key, path);
  }
}

const decision = readFileSync(
  join(repositoryRoot, "docs", "releases", "naming-decision.md"),
  "utf8",
);
for (const required of [
  "`Pactmark`",
  "scope `@pactmark`",
  "`create-pactmark`",
  "`npm create pactmark@latest`",
  "`pactmark/pactmark`",
  "No `@pactmark/pactmark` package",
] as const) {
  if (!decision.includes(required)) failures.push(`KAF_NAMING_DECISION_DRIFT:${required}`);
}

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
let publishablePackages = 0;
for (const path of files.filter((file) => basename(file) === "package.json")) {
  const manifest = readJson(join(repositoryRoot, path)) as PackageManifest;
  if (manifest.name === "@pactmark/pactmark") {
    failures.push(`KAF_NAMING_FORBIDDEN_FACADE:${path}`);
  }
  for (const field of dependencyFields) {
    const dependencies = manifest[field];
    if (dependencies !== null && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      if ("@pactmark/pactmark" in dependencies) {
        failures.push(`KAF_NAMING_FORBIDDEN_DEPENDENCY:${path}:${field}`);
      }
    }
  }
  if (manifest.private === true) continue;
  publishablePackages += 1;
  if (
    typeof manifest.name !== "string" ||
    (!manifest.name.startsWith("@pactmark/") && manifest.name !== "create-pactmark")
  ) {
    failures.push(`KAF_NAMING_PUBLISHABLE_NAME_INVALID:${path}:${String(manifest.name)}`);
  }
  const repository = manifest.repository;
  const expectedDirectory = path.replace(/\/package\.json$/u, "");
  if (repository === null || typeof repository !== "object" || Array.isArray(repository)) {
    failures.push(`KAF_RELEASE_REPOSITORY_METADATA_REQUIRED:${path}`);
  } else {
    const metadata = repository as Readonly<Record<string, unknown>>;
    if (
      metadata.type !== "git" ||
      metadata.url !== expectedRepositoryUrl ||
      metadata.directory !== expectedDirectory ||
      Object.keys(metadata).sort().join(",") !== "directory,type,url"
    ) {
      failures.push(`KAF_RELEASE_REPOSITORY_METADATA_INVALID:${path}`);
    }
  }
  if (manifest.publishConfig?.registry !== "https://registry.npmjs.org/") {
    failures.push(`KAF_NAMING_REGISTRY_INVALID:${path}`);
  }
  if (typeof manifest.name === "string" && manifest.name.startsWith("@pactmark/")) {
    if (manifest.publishConfig?.access !== "public") {
      failures.push(`KAF_NAMING_SCOPE_ACCESS_INVALID:${path}`);
    }
  }
}

for (const path of files.filter((file) => /\.(?:[cm]?[jt]sx?)$/u.test(file))) {
  const source = readFileSync(join(repositoryRoot, path), "utf8");
  if (/from\s+["']@pactmark\/pactmark(?:[/"'])/u.test(source)) {
    failures.push(`KAF_NAMING_FORBIDDEN_IMPORT:${path}`);
  }
}

if (publishablePackages !== 19) {
  failures.push(`KAF_NAMING_PUBLISHABLE_COUNT:${String(publishablePackages)}:expected=19`);
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `KAF_NAMING_FREEZE_OK display=Pactmark scope=@pactmark initializer=create-pactmark repository=pactmark/pactmark publishable=${String(publishablePackages)} caseCollisions=0 metadataProfile=release\n`,
  );
}
