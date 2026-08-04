import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { packPublishablePackages } from "./packed-artifacts.mjs";
import { repositoryRoot } from "../lib/repository.mjs";

const destination = resolve(
  process.argv[2] ?? join(repositoryRoot, ".artifacts", "packed-consumer", "tarballs"),
);
const cacheDirectory = join(destination, "..", "npm-cache");
mkdirSync(destination, { recursive: true, mode: 0o700 });
const artifacts = await packPublishablePackages({
  destination,
  npmCacheDirectory: cacheDirectory,
  verifyNpmDeterminism: true,
});
const manifest = {
  schemaVersion: "1",
  publication: "not_authorized",
  packageManagerMatrix: {
    npm: "packed_entrypoint_tested_separately",
    pnpm: "packed_consumer_tested",
    yarn4: "separate_gate:test:loopback-registry",
    bun: "separate_gate:test:loopback-registry",
  },
  loopbackRegistry: "separate_gate:test:loopback-registry",
  packages: artifacts.map(({ tarballPath, ...artifact }) => ({
    ...artifact,
    tarball: tarballPath.slice(destination.length + 1),
  })),
};
const manifestPath = join(destination, "..", "manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(
  `Validated ${String(artifacts.length)} publishable Pactmark tarballs; no registry write performed.\n`,
);
