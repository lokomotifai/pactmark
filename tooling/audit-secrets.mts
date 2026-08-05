import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { gitFiles, repositoryRoot } from "./lib/repository.mjs";

const textExtensions = new Set([
  "",
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const excluded = new Set(["tooling/audit-secrets.mts"]);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bnpm_[A-Za-z0-9]{30,}\b/u,
  /\bsk-(?:live|proj)-[A-Za-z0-9_-]{20,}\b/u,
] as const;
const findings: string[] = [];

for (const path of gitFiles()) {
  if (excluded.has(path) || !textExtensions.has(extname(path))) continue;
  const content = readFileSync(`${repositoryRoot}/${path}`, "utf8");
  if (secretPatterns.some((pattern) => pattern.test(content))) findings.push(path);
}

if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`KAF_SECRET_CANARY_MATCH ${finding}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Repository secret-pattern audit passed.\n");
}
