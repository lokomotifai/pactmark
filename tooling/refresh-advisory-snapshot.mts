import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repositoryRoot } from "./lib/repository.mjs";

const pnpmCliPath = join(repositoryRoot, "node_modules", "pnpm", "bin", "pnpm.mjs");
const root = mkdtempSync(join(tmpdir(), "pactmark-advisory-refresh-"));
try {
  const audit = spawnSync(
    process.execPath,
    [pnpmCliPath, "audit", "--json", "--audit-level", "high"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (audit.error !== undefined || (audit.status !== 0 && audit.status !== 1)) {
    throw new Error("KAF_ADVISORY_UPSTREAM_FETCH_FAILED", { cause: audit.error });
  }
  try {
    JSON.parse(audit.stdout) as unknown;
  } catch (cause) {
    throw new Error("KAF_ADVISORY_UPSTREAM_EXPORT_INVALID", { cause });
  }
  const auditPath = join(root, "audit.json");
  writeFileSync(auditPath, audit.stdout, { mode: 0o600 });
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      join(repositoryRoot, "tooling", "create-advisory-snapshot.mts"),
      auditPath,
      join(repositoryRoot, "pnpm-lock.yaml"),
      join(repositoryRoot, "tooling", "advisories", "npm-audit.snapshot.json"),
      join(repositoryRoot, "tooling", "advisories", "npm-audit.snapshot.sha256"),
      new Date().toISOString(),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    },
  );
  process.stdout.write(output);
} finally {
  rmSync(root, { recursive: true, force: true });
}
