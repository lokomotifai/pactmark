import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { repositoryRoot } from "./lib/repository.mjs";

const output = join(repositoryRoot, ".artifacts", "advisory-bootstrap", "npm-audit.json");
mkdirSync(join(repositoryRoot, ".artifacts", "advisory-bootstrap"), { recursive: true });
const audit = spawnSync(join(repositoryRoot, "node_modules", ".bin", "pnpm"), ["audit", "--json"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (audit.error !== undefined) throw audit.error;
if (audit.status !== 0 && audit.status !== 1) {
  throw new Error(
    `KAF_ADVISORY_UPSTREAM_UNAVAILABLE:${String(audit.status)}:${audit.stderr.slice(0, 500)}`,
  );
}
JSON.parse(audit.stdout);
writeFileSync(output, audit.stdout, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ output, auditExitStatus: audit.status })}\n`);
