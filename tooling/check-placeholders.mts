import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { gitFiles, repositoryRoot } from "./lib/repository.mjs";

const scannedExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const excluded = new Set(["tooling/check-placeholders.mts", ".changeset/initial-release.md"]);
const prosePrefixes = ["docs/", ".github/"];
const findings: string[] = [];
const markers = [
  ["unfinished marker", /\b(?:TO" + "DO|TB" + "D|FIX" + "ME)\b/gu],
  ["skipped test", /\b(?:it|test|describe)\.(?:skip|todo)\s*\(/gu],
  ["focused test", /\b(?:it|test|describe)\.only\s*\(/gu],
] as const;

for (const path of gitFiles()) {
  if (excluded.has(path) || prosePrefixes.some((prefix) => path.startsWith(prefix))) continue;
  if (!scannedExtensions.has(extname(path))) continue;
  const content = readFileSync(`${repositoryRoot}/${path}`, "utf8");
  for (const [label, pattern] of markers) {
    if (pattern.test(content)) findings.push(`${path}: ${label}`);
    pattern.lastIndex = 0;
  }
}

if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`KAF_RELEASE_PLACEHOLDER ${finding}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("No unexplained release-path placeholders or skipped tests found.\n");
}
