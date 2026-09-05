import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

const ignoredDirectoryNames = new Set([
  ".artifacts",
  ".git",
  ".next",
  ".pnpm-store",
  ".turbo",
  ".vercel",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
]);

export function walkFiles(root = repositoryRoot): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

export function relativePath(path: string): string {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

export function gitFiles(): readonly string[] {
  try {
    const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    return output
      .split("\n")
      .filter((path) => path.length > 0 && existsSync(join(repositoryRoot, path)))
      .sort();
  } catch {
    return walkFiles().map(relativePath);
  }
}

export interface GitSourceState {
  readonly commit: string;
  readonly clean: boolean;
}

export function gitSourceState(root = repositoryRoot): GitSourceState {
  try {
    const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("KAF_GIT_COMMIT_INVALID");
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { commit, clean: status.trim().length === 0 };
  } catch {
    return { commit: "uncommitted-local-source", clean: false };
  }
}

export function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function existingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
