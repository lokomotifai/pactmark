import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { gitFiles, repositoryRoot } from "./lib/repository.mjs";

const executableExtensions = new Set([
  ".cjs",
  ".js",
  ".mjs",
  ".mts",
  ".sh",
  ".ts",
  ".yaml",
  ".yml",
]);
const protectedPackageFiles = new Set(["package.json"]);
const allowedImplementation = "tooling/release-publish.mts";
const negativeFixtureRoot = "fixtures/security/raw-release-command/";
const documentationAllowlistPath = "tooling/release-command-doc-allowlist.json";
const forbidden = [
  /\b(?:npm|pnpm|yarn)\s+publish\b/u,
  /\bnpm\s+dist-tag\s+(?:add|set|rm)\b/u,
  /\b(?:npm|pnpm)_config_registry\s*=\s*https?:\/\/(?!127\.0\.0\.1|\[::1\])/u,
];

export interface ReleaseCommandFinding {
  readonly path: string;
  readonly line: number;
  readonly excerpt: string;
}

export function auditReleaseCommands(
  root = repositoryRoot,
  paths = gitFiles(),
): readonly ReleaseCommandFinding[] {
  const findings: ReleaseCommandFinding[] = [];
  const allowlistFile = join(root, documentationAllowlistPath);
  const documentationAllowlist = new Set<string>();
  if (existsSync(allowlistFile)) {
    const parsed = JSON.parse(readFileSync(allowlistFile, "utf8")) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("paths" in parsed) ||
      !Array.isArray(parsed.paths)
    ) {
      throw new Error("KAF_RELEASE_DOCUMENTATION_ALLOWLIST_INVALID");
    }
    for (const path of parsed.paths) {
      if (typeof path !== "string" || !path.endsWith(".md")) {
        throw new Error("KAF_RELEASE_DOCUMENTATION_ALLOWLIST_INVALID");
      }
      documentationAllowlist.add(path);
    }
  }
  for (const path of paths) {
    if (path === allowedImplementation || path.startsWith(negativeFixtureRoot)) continue;
    const documentationWithMutationText =
      extname(path) === ".md" &&
      forbidden.some((pattern) => pattern.test(readFileSync(join(root, path), "utf8")));
    if (documentationWithMutationText && !documentationAllowlist.has(path)) {
      findings.push({ path, line: 1, excerpt: "unreviewed release-mutation documentation" });
      continue;
    }
    if (extname(path) === ".md") continue;
    if (
      !executableExtensions.has(extname(path)) &&
      !protectedPackageFiles.has(path.split("/").at(-1) ?? "")
    )
      continue;
    const content = readFileSync(join(root, path), "utf8");
    content.split("\n").forEach((line, index) => {
      if (forbidden.some((pattern) => pattern.test(line))) {
        findings.push({ path, line: index + 1, excerpt: line.trim().slice(0, 160) });
      }
    });
  }
  return findings;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = auditReleaseCommands();
  if (findings.length > 0) {
    process.stderr.write(
      `${JSON.stringify({ code: "KAF_RELEASE_RAW_COMMAND", findings }, null, 2)}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      "Release command audit passed: guarded publisher is the only executable mutation path.\n",
    );
  }
}
