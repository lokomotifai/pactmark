import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { packPublishablePackages, tarballDependencyMap } from "./packed-artifacts.mjs";
import { repositoryRoot } from "../lib/repository.mjs";

const fixtureRoot = join(repositoryRoot, ".artifacts", "packed-consumer-lock");
const tarballRoot = join(fixtureRoot, "tarballs");
const consumerRoot = join(fixtureRoot, "consumer");
const outputPath = join(
  repositoryRoot,
  "tests",
  "fixtures",
  "packed-consumer",
  "pnpm-lock.template.yaml",
);
const pnpmStoreDirectory =
  process.env["PACTMARK_PNPM_STORE"] ?? join(repositoryRoot, ".pnpm-store");
const tarballRootPlaceholder = "__PACTMARK_TARBALL_ROOT__";

rmSync(fixtureRoot, { recursive: true, force: true });
mkdirSync(consumerRoot, { recursive: true });

const artifacts = await packPublishablePackages({
  destination: tarballRoot,
  npmCacheDirectory: join(fixtureRoot, "npm-cache"),
  verifyNpmDeterminism: true,
});
const tarballs = tarballDependencyMap(artifacts);

writeFileSync(
  join(consumerRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "pactmark-packed-consumer-lock-template",
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
  join(consumerRoot, "pnpm-workspace.yaml"),
  `trustLockfile: true\nenableGlobalVirtualStore: false\ndedupeInjectedDeps: false\noverrides:\n${Object.entries(
    tarballs,
  )
    .map(([packageName, tarball]) => `  ${JSON.stringify(packageName)}: ${JSON.stringify(tarball)}`)
    .join("\n")}\n`,
);

execFileSync(
  join(repositoryRoot, "node_modules", ".bin", "pnpm"),
  [
    "install",
    "--lockfile-only",
    "--offline",
    "--ignore-scripts",
    "--frozen-lockfile=false",
    "--store-dir",
    pnpmStoreDirectory,
  ],
  { cwd: consumerRoot, encoding: "utf8", stdio: "inherit" },
);

let lockfile = readFileSync(join(consumerRoot, "pnpm-lock.yaml"), "utf8").replaceAll(
  tarballRoot,
  tarballRootPlaceholder,
);
if (!lockfile.includes(tarballRootPlaceholder)) {
  throw new Error("KAF_CONSUMER_LOCK_TARBALL_PLACEHOLDER_MISSING");
}
for (const [index, artifact] of artifacts.entries()) {
  const placeholder = `__PACTMARK_TARBALL_INTEGRITY_${String(index)}__`;
  if (!lockfile.includes(artifact.integrity)) {
    throw new Error(`KAF_CONSUMER_LOCK_TARBALL_INTEGRITY_MISSING:${artifact.name}`);
  }
  lockfile = lockfile.replaceAll(artifact.integrity, placeholder);
}
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, lockfile);
execFileSync(join(repositoryRoot, "node_modules", ".bin", "prettier"), ["--write", outputPath], {
  cwd: repositoryRoot,
  encoding: "utf8",
  stdio: "inherit",
});
process.stdout.write(`KAF_CONSUMER_LOCK_TEMPLATE_WRITTEN ${outputPath}\n`);
