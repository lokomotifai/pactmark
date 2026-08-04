import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";

import { repositoryRoot } from "../lib/repository.mjs";

const pnpmCliPath = join(repositoryRoot, "node_modules", "pnpm", "bin", "pnpm.mjs");
const pnpmStoreDirectory =
  process.env["PACTMARK_PNPM_STORE"] ??
  execFileSync(process.execPath, [pnpmCliPath, "store", "path"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();

export function nearestRankPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0 || !Number.isFinite(percentile) || percentile <= 0 || percentile > 1)
    throw new TypeError("KAF_BENCH_PERCENTILE_INVALID");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? 0;
}

export interface PackedQuickstartResult {
  readonly schemaVersion: "1";
  readonly benchmark: "packed-runtime-quickstart";
  readonly runs: number;
  readonly samplesMilliseconds: readonly number[];
  readonly p90Milliseconds: number;
  readonly environment: Readonly<{ node: string; platform: string; architecture: string }>;
  readonly tarballDigests: Readonly<Record<string, string>>;
  readonly method: string;
  readonly limitation: string;
}

function digest(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function integrity(path: string): string {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

function installFailureOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) return "KAF_BENCH_INSTALL_OUTPUT_UNAVAILABLE";
  const output = [
    "stdout" in error ? String(error.stdout) : "",
    "stderr" in error ? String(error.stderr) : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n")
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gu, "$1[redacted]@")
    .replace(/(?:token|password|secret|credential)\s*[=:]\s*\S+/giu, "[redacted]");
  return output.length > 0 ? output.slice(0, 4_096) : "KAF_BENCH_INSTALL_OUTPUT_UNAVAILABLE";
}

export async function runPackedQuickstartBenchmark(
  options: Readonly<{ runs?: number; tarballDirectory?: string }> = {},
): Promise<PackedQuickstartResult> {
  const runs = options.runs ?? 5;
  if (!Number.isSafeInteger(runs) || runs < 5 || runs > 20)
    throw new TypeError("KAF_BENCH_RUN_COUNT_INVALID");
  const tarballDirectory =
    options.tarballDirectory ?? join(repositoryRoot, ".artifacts", "release-dry-run", "tarballs");
  const tarballs = {
    "@pactmark/agent": join(tarballDirectory, "pactmark-agent-0.1.0.tgz"),
    "@pactmark/core": join(tarballDirectory, "pactmark-core-0.1.0.tgz"),
    "@pactmark/evidence": join(tarballDirectory, "pactmark-evidence-0.1.0.tgz"),
    "@pactmark/executor-in-process": join(
      tarballDirectory,
      "pactmark-executor-in-process-0.1.0.tgz",
    ),
    "@pactmark/policy": join(tarballDirectory, "pactmark-policy-0.1.0.tgz"),
    "@pactmark/runtime": join(tarballDirectory, "pactmark-runtime-0.1.0.tgz"),
    "@pactmark/store-memory": join(tarballDirectory, "pactmark-store-memory-0.1.0.tgz"),
  } as const;
  for (const path of Object.values(tarballs)) readFileSync(path);
  const root = await mkdtemp(join(tmpdir(), "pactmark-packed-quickstart-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "tarballs"), { recursive: true });
    for (const path of Object.values(tarballs)) {
      cpSync(path, join(root, "tarballs", basename(path)));
    }
    cpSync(
      join(repositoryRoot, "tooling", "benchmarks", "fixtures", "packed-quickstart.mjs"),
      join(root, "src", "quickstart.mjs"),
    );
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "pactmark-packed-quickstart-benchmark", private: true, type: "module", dependencies: { "@pactmark/agent": `file:tarballs/${basename(tarballs["@pactmark/agent"])}`, "@pactmark/core": `file:tarballs/${basename(tarballs["@pactmark/core"])}`, zod: "4.4.3" } }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      `trustLockfile: true\noverrides:\n${Object.entries(tarballs)
        .map(
          ([name, path]) =>
            `  ${JSON.stringify(name)}: ${JSON.stringify(`file:tarballs/${basename(path)}`)}`,
        )
        .join("\n")}\n`,
    );
    let lockfile = readFileSync(
      join(repositoryRoot, "tooling", "benchmarks", "fixtures", "packed-quickstart-lock.yaml"),
      "utf8",
    );
    for (const [placeholder, path] of Object.entries({
      __PACTMARK_AGENT_INTEGRITY__: tarballs["@pactmark/agent"],
      __PACTMARK_CORE_INTEGRITY__: tarballs["@pactmark/core"],
      __PACTMARK_EVIDENCE_INTEGRITY__: tarballs["@pactmark/evidence"],
      __PACTMARK_EXECUTOR_IN_PROCESS_INTEGRITY__: tarballs["@pactmark/executor-in-process"],
      __PACTMARK_RUNTIME_INTEGRITY__: tarballs["@pactmark/runtime"],
      __PACTMARK_STORE_MEMORY_INTEGRITY__: tarballs["@pactmark/store-memory"],
    })) {
      if (!lockfile.includes(placeholder)) throw new Error("KAF_BENCH_LOCK_PLACEHOLDER_MISSING");
      lockfile = lockfile.replaceAll(placeholder, integrity(path));
    }
    if (lockfile.includes("__PACTMARK_")) throw new Error("KAF_BENCH_LOCK_UNRESOLVED");
    writeFileSync(join(root, "pnpm-lock.yaml"), lockfile);
    try {
      execFileSync(
        process.execPath,
        [
          pnpmCliPath,
          "install",
          "--offline",
          "--ignore-scripts",
          "--frozen-lockfile",
          "--store-dir",
          pnpmStoreDirectory,
        ],
        { cwd: root, encoding: "utf8", stdio: "pipe" },
      );
    } catch (error) {
      throw new Error(`KAF_BENCH_INSTALL_FAILED\n${installFailureOutput(error)}`, { cause: error });
    }
    const samples: number[] = [];
    for (let index = 0; index < runs; index += 1) {
      const started = performance.now();
      const output = execFileSync(process.execPath, [join(root, "src", "quickstart.mjs")], {
        cwd: root,
        encoding: "utf8",
      });
      samples.push(performance.now() - started);
      const parsed = JSON.parse(output) as Readonly<{ status?: unknown; profile?: unknown }>;
      if (parsed.status !== "completed" || parsed.profile !== "ephemeral")
        throw new Error("KAF_BENCH_PACKED_RUN_FAILED");
    }
    return Object.freeze({
      schemaVersion: "1",
      benchmark: "packed-runtime-quickstart",
      runs,
      samplesMilliseconds: Object.freeze(samples),
      p90Milliseconds: nearestRankPercentile(samples, 0.9),
      environment: Object.freeze({
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      }),
      tarballDigests: Object.freeze(
        Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [name, digest(path)])),
      ),
      method: `Tarballs prebuilt; one offline independent install excluded from samples; ${String(runs)} fresh Node processes measured from spawn to completed deterministic streamed runtime result; nearest-rank p90`,
      limitation:
        "This is a packed runtime startup baseline, not the initializer-to-first-run product SLO; dependency install, initializer generation, and network latency are excluded.",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
