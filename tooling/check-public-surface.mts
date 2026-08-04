import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

import {
  existingDirectory,
  readJson,
  relativePath,
  repositoryRoot,
  walkFiles,
} from "./lib/repository.mjs";

type PackageManifest = {
  readonly name?: unknown;
  readonly private?: unknown;
  readonly license?: unknown;
  readonly types?: unknown;
  readonly exports?: unknown;
  readonly files?: unknown;
  readonly publishConfig?: {
    readonly access?: unknown;
    readonly registry?: unknown;
  };
};

const failures: string[] = [];
const forbiddenRoots = ["briefs", "research"] as const;
const forbiddenPackagedNames = [
  /^\.env(?:\.|$)/u,
  /\.(?:pem|p12|pfx|key|sqlite|db)$/u,
  /^(?:coverage|test-results)$/u,
];

function checkTrackedPrivateInputs(): void {
  let tracked = "";
  try {
    tracked = execFileSync("git", ["ls-files", "--", ...forbiddenRoots], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    failures.push("Git index could not be inspected.");
  }
  if (tracked) failures.push(`Private bootstrap inputs are tracked: ${tracked}`);
}

function checkOutputTree(root: string): void {
  if (!existingDirectory(root)) return;
  for (const file of walkFiles(root)) {
    const path = relative(root, file).replaceAll("\\", "/");
    const components = path.split("/");
    if (components.some((component) => forbiddenRoots.includes(component as never))) {
      failures.push(`Private bootstrap path found in output: ${relativePath(file)}`);
    }
    if (
      components.some((component) => forbiddenPackagedNames.some((rule) => rule.test(component)))
    ) {
      failures.push(`Forbidden file found in output: ${relativePath(file)}`);
    }
  }
}

function checkTarballs(): void {
  for (const file of walkFiles().filter((path) => extname(path) === ".tgz")) {
    const listing = execFileSync("tar", ["-tzf", file], { encoding: "utf8" });
    for (const entry of listing.split("\n").filter(Boolean)) {
      const components = entry.split("/");
      if (components.some((component) => forbiddenRoots.includes(component as never))) {
        failures.push(`Private bootstrap path found in ${basename(file)}: ${entry}`);
      }
      if (
        components.some((component) => forbiddenPackagedNames.some((rule) => rule.test(component)))
      ) {
        failures.push(`Forbidden file found in ${basename(file)}: ${entry}`);
      }
    }
  }
}

function checkPublishablePackages(): void {
  for (const manifestPath of walkFiles().filter((path) => basename(path) === "package.json")) {
    if (manifestPath.includes(join("fixtures", "invalid-"))) continue;
    const manifest = readJson(manifestPath) as PackageManifest;
    if (manifest.private === true) continue;
    const packageDirectory = dirname(manifestPath);
    const label =
      typeof manifest.name === "string" ? manifest.name : relativePath(packageDirectory);
    if (manifest.license !== "Apache-2.0") failures.push(`${label}: license must be Apache-2.0.`);
    if (typeof manifest.types !== "string") failures.push(`${label}: types entry is required.`);
    if (manifest.exports === undefined) failures.push(`${label}: exports declaration is required.`);
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      failures.push(`${label}: files allowlist is required.`);
    }
    if (!existsSync(join(packageDirectory, "README.md")))
      failures.push(`${label}: README.md is required.`);
    if (
      !existsSync(join(packageDirectory, "LICENSE")) &&
      !existsSync(join(repositoryRoot, "LICENSE"))
    ) {
      failures.push(`${label}: LICENSE is required.`);
    }
    if (manifest.publishConfig?.registry !== "https://registry.npmjs.org/") {
      failures.push(`${label}: publishConfig.registry must be the public npm registry.`);
    }
    if (typeof manifest.name === "string" && manifest.name.startsWith("@")) {
      if (manifest.publishConfig?.access !== "public") {
        failures.push(`${label}: scoped package publishConfig.access must be public.`);
      }
    }
  }
}

function checkRepositorySecretNames(): void {
  for (const file of walkFiles()) {
    const path = relativePath(file);
    if (basename(path) === ".env.example") continue;
    const components = path.split("/");
    if (
      components.some((component) => forbiddenPackagedNames.some((rule) => rule.test(component)))
    ) {
      failures.push(`Forbidden repository file: ${path}`);
    }
  }
}

checkTrackedPrivateInputs();
checkRepositorySecretNames();
checkOutputTree(join(repositoryRoot, "apps", "docs", "dist"));
checkOutputTree(join(repositoryRoot, ".artifacts"));
checkTarballs();
checkPublishablePackages();

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`KAF_PUBLIC_SURFACE_UNSAFE ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Pactmark public surface check passed.\n");
}
