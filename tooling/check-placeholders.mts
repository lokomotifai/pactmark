import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";

import { gitFiles, repositoryRoot } from "./lib/repository.mjs";

const scannedExtensions = new Set([
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
const unfinishedTokens = [["TO", "DO"].join(""), ["T", "BD"].join(""), ["FIX", "ME"].join("")];

export const placeholderMarkers = Object.freeze([
  ["unfinished marker", new RegExp(`\\b(?:${unfinishedTokens.join("|")})\\b`, "gu")],
  ["skipped test", /\b(?:it|test|describe)\.(?:skip|todo)\s*\(/gu],
  ["focused test", /\b(?:it|test|describe)\.only\s*\(/gu],
] as const);

export function scanPlaceholderContents(
  entries: Iterable<readonly [path: string, content: string]>,
): readonly string[] {
  const findings: string[] = [];
  for (const [path, content] of entries) {
    if (!scannedExtensions.has(extname(path))) continue;
    for (const [label, pattern] of placeholderMarkers) {
      if (pattern.test(content)) findings.push(`${path}: ${label}`);
      pattern.lastIndex = 0;
    }
  }
  return findings;
}

export function checkRepositoryPlaceholders(): readonly string[] {
  return scanPlaceholderContents(
    gitFiles()
      .filter((path) => existsSync(`${repositoryRoot}/${path}`))
      .map((path) => [path, readFileSync(`${repositoryRoot}/${path}`, "utf8")] as const),
  );
}

function main(): void {
  const findings = checkRepositoryPlaceholders();
  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`KAF_RELEASE_PLACEHOLDER ${finding}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("No unexplained release-path placeholders or skipped tests found.\n");
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) main();
