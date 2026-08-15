import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { gitFiles, repositoryRoot } from "./lib/repository.mjs";

const excluded = new Set(["tooling/audit-secrets.mts"]);
const secretPatterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/u],
  ["npm-token", /\bnpm_[A-Za-z0-9]{30,}\b/u],
  ["openai-token", /\bsk-(?:live|proj)-[A-Za-z0-9_-]{20,}\b/u],
  ["anthropic-token", /\bsk-ant-[A-Za-z0-9_-]{24,}\b/u],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/u],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/u],
  ["stripe-live-key", /\b[rs]k_live_[0-9A-Za-z]{20,}\b/u],
  ["gitlab-token", /\bglpat-[0-9A-Za-z_-]{20,}\b/u],
] as const;
const findings: string[] = [];

function scan(source: string, content: string): void {
  for (const [kind, pattern] of secretPatterns) {
    if (pattern.test(content)) findings.push(`${kind}:${source}`);
  }
}

for (const path of gitFiles()) {
  if (excluded.has(path)) continue;
  const content = readFileSync(`${repositoryRoot}/${path}`);
  if (content.includes(0)) continue;
  scan(path, content.toString("utf8"));
}

const history = execFileSync("git", ["log", "-p", "--all", "--no-ext-diff", "--pretty=format:"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
});
scan("git-history", history);

if (findings.length > 0) {
  for (const finding of [...new Set(findings)].sort()) {
    process.stderr.write(`KAF_SECRET_PATTERN_MATCH ${finding}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write("Repository and Git history secret-pattern audit passed.\n");
}
