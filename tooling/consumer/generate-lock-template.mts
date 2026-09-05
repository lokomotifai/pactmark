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
const pnpmCliPath = join(repositoryRoot, "node_modules", "pnpm", "bin", "pnpm.mjs");
const pnpmStoreDirectory =
  process.env["PACTMARK_PNPM_STORE"] ??
  execFileSync(process.execPath, [pnpmCliPath, "store", "path"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
const tarballRootPlaceholder = "__PACTMARK_TARBALL_ROOT__";
const externalOverrides = {
  "@hono/node-server": "2.0.12",
  "eventsource-parser": "3.1.0",
  "express-rate-limit": "8.6.1",
  "fast-uri": "3.1.6",
  hono: "4.12.34",
  "ip-address": "10.4.0",
  jose: "6.2.7",
  nanoid: "3.3.17",
  "pg-protocol": "1.15.0",
} as const;

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
    { ...tarballs, ...externalOverrides },
  )
    .map(([packageName, tarball]) => `  ${JSON.stringify(packageName)}: ${JSON.stringify(tarball)}`)
    .join("\n")}\n`,
);

execFileSync(
  process.execPath,
  [
    pnpmCliPath,
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
