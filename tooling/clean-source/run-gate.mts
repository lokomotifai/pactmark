import { spawnSync, execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import { canonicalJson, sha256Bytes } from "../lib/release-integrity.mjs";
import { gitFiles, repositoryRoot, sha256File } from "../lib/repository.mjs";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

function sourcePath(path: string): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("../") ||
    path.includes("\\") ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`KAF_CLEAN_SOURCE_PATH_INVALID:${path}`);
  }
  return path;
}

function runLogged(
  command: string,
  args: readonly string[],
  cwd: string,
  logPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const descriptor = openSync(logPath, "w", 0o600);
  try {
    const result = spawnSync(command, [...args], {
      cwd,
      env: environment,
      stdio: ["ignore", descriptor, descriptor],
    });
    if (result.error !== undefined) {
      throw new Error(`KAF_CLEAN_SOURCE_COMMAND_ERROR:${result.error.message}`);
    }
    if (result.status !== 0) {
      const status = result.status === null ? "signal" : result.status.toString();
      throw new Error(`KAF_CLEAN_SOURCE_COMMAND_FAILED:${status}:${logPath}`);
    }
  } finally {
    closeSync(descriptor);
  }
}

const outputDirectory = join(repositoryRoot, ".artifacts", "clean-source-verify");
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

const temporaryRoot = mkdtempSync(join(tmpdir(), "pactmark-clean-source-"));
const sourceRoot = join(temporaryRoot, "source");
mkdirSync(sourceRoot);

try {
  const files = gitFiles()
    .map(sourcePath)
    .filter((path) => !path.startsWith("briefs/") && !path.startsWith("research/"));
  if (files.length === 0) throw new Error("KAF_CLEAN_SOURCE_EMPTY");
  if (new Set(files).size !== files.length) throw new Error("KAF_CLEAN_SOURCE_DUPLICATE");

  const sourceEntries = files.map((path) => {
    const original = join(repositoryRoot, path);
    const stats = lstatSync(original);
    if (!stats.isFile()) throw new Error(`KAF_CLEAN_SOURCE_NON_FILE:${path}`);
    const destination = join(sourceRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(original, destination);
    chmodSync(destination, stats.mode & 0o777);
    return { path, digest: sha256File(original) };
  });
  const sourceTreeDigest = sha256Bytes(
    Buffer.from(canonicalJson({ schemaVersion: "1", files: sourceEntries })),
  );

  execFileSync("git", ["init", "--quiet"], { cwd: sourceRoot });
  execFileSync("git", ["add", "--all"], { cwd: sourceRoot });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Pactmark Conformance",
      "-c",
      "user.email=conformance@pactmark.invalid",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "clean source verification baseline",
    ],
    {
      cwd: sourceRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    },
  );
  const baselineCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const baselineGitTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();

  const rootPnpm = join(repositoryRoot, "node_modules", ".bin", "pnpm");
  const bootstrapLogPath = join(outputDirectory, "bootstrap.log");
  runLogged(
    rootPnpm,
    [
      "install",
      "--offline",
      "--frozen-lockfile",
      "--store-dir",
      join(repositoryRoot, ".pnpm-store"),
      "--config.dedupe-injected-deps=false",
    ],
    sourceRoot,
    bootstrapLogPath,
  );

  const verifyLogPath = join(outputDirectory, "verify.log");
  const startedAt = new Date().toISOString();
  runLogged(
    join(sourceRoot, "node_modules", ".bin", "pnpm"),
    ["verify"],
    sourceRoot,
    verifyLogPath,
    {
      ...process.env,
      CI: "1",
      PACTMARK_PNPM_STORE: join(repositoryRoot, ".pnpm-store"),
    },
  );
  const completedAt = new Date().toISOString();

  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  if (status.length !== 0) throw new Error(`KAF_CLEAN_SOURCE_DIRTY_AFTER_VERIFY:${status}`);

  const releaseManifestPath = join(
    sourceRoot,
    ".artifacts",
    "release-dry-run",
    "release-manifest.json",
  );
  const releaseManifest = record(
    JSON.parse(readFileSync(releaseManifestPath, "utf8")) as unknown,
    "KAF_CLEAN_SOURCE_RELEASE_MANIFEST_INVALID",
  );
  const releaseSource = record(
    releaseManifest["source"],
    "KAF_CLEAN_SOURCE_RELEASE_IDENTITY_INVALID",
  );
  if (releaseSource["clean"] !== true || releaseSource["commit"] !== baselineCommit) {
    throw new Error("KAF_CLEAN_SOURCE_RELEASE_IDENTITY_MISMATCH");
  }
  const packages = releaseManifest["packages"];
  if (!Array.isArray(packages) || packages.length !== 19) {
    throw new Error("KAF_CLEAN_SOURCE_RELEASE_PACKAGE_COUNT_INVALID");
  }

  const result = {
    schemaVersion: "1",
    gate: "clean-source-verify",
    sourceFiles: files.length,
    sourceTreeDigest,
    baselineCommit,
    baselineGitTree,
    nodeVersion: process.version,
    pnpmVersion: "11.18.0",
    startedAt,
    completedAt,
    bootstrapMode: "offline-shared-content-addressable-store",
    bootstrapLogDigest: sha256File(bootstrapLogPath),
    verifyLogDigest: sha256File(verifyLogPath),
    releaseManifestDigest: sha256File(releaseManifestPath),
    releaseSourceTreeDigest: releaseSource["tree"],
    packageCount: packages.length,
    sourceCleanAfterVerify: true,
    publication: "not_authorized",
  };
  const resultPath = join(outputDirectory, "result.json");
  writeFileSync(resultPath, `${canonicalJson(result)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...result, resultPath })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
