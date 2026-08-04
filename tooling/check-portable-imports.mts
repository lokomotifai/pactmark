import { readFileSync } from "node:fs";
import { join } from "node:path";

import { existingDirectory, repositoryRoot, relativePath, walkFiles } from "./lib/repository.mjs";

const portableRoots = [
  join(repositoryRoot, "packages", "core", "src"),
  join(repositoryRoot, "packages", "runtime", "src"),
  join(repositoryRoot, "packages", "policy", "src"),
  join(repositoryRoot, "packages", "evidence", "src"),
];
const forbiddenSpecifier =
  /^(?:node:|next(?:\/|$)|@vercel(?:\/|$)|cloudflare:|ai$|@ai-sdk(?:\/|$))/u;
const importSpecifier = /(?:from\s*|import\s*\()\s*["']([^"']+)["']/gu;
const findings: string[] = [];

for (const root of portableRoots) {
  if (!existingDirectory(root)) continue;
  for (const file of walkFiles(root).filter((path) => path.endsWith(".ts"))) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(importSpecifier)) {
      const specifier = match[1] ?? "";
      if (forbiddenSpecifier.test(specifier)) {
        findings.push(`${relativePath(file)} imports ${specifier}`);
      }
    }
    if (/\bprocess\.env\b/u.test(content)) findings.push(`${relativePath(file)} reads process.env`);
  }
}

if (findings.length > 0) {
  for (const finding of findings)
    process.stderr.write(`KAF_PORTABLE_IMPORT_FORBIDDEN ${finding}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Portable package import boundary passed.\n");
}
