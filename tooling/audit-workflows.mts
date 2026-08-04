import { readFileSync } from "node:fs";

import { gitFiles, repositoryRoot } from "./lib/repository.mjs";

const findings: string[] = [];
const actionReference = /\buses:\s*([^\s#]+)@([^\s#]+)/gu;
const fullCommit = /^[0-9a-f]{40}$/u;

for (const path of gitFiles().filter((entry) => entry.startsWith(".github/workflows/"))) {
  const content = readFileSync(`${repositoryRoot}/${path}`, "utf8");
  for (const match of content.matchAll(actionReference)) {
    const action = match[1] ?? "";
    const reference = match[2] ?? "";
    if (action.startsWith("./")) continue;
    if (!fullCommit.test(reference)) findings.push(`${path}: ${action}@${reference}`);
  }
}

if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`KAF_WORKFLOW_MUTABLE_ACTION ${finding}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Workflow action references are immutable.\n");
}
