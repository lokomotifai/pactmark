type JsonRecord = Record<string, unknown>;

export interface VerifyGateManifest {
  readonly schemaVersion: "1";
  readonly aggregates: Readonly<Record<string, readonly string[]>>;
  readonly externalGates: readonly string[];
  readonly forbiddenNoOpPatterns: readonly string[];
}

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

export function parseVerifyGateManifest(value: unknown): VerifyGateManifest {
  const root = record(value, "KAF_VERIFY_MANIFEST_INVALID");
  if (root.schemaVersion !== "1") throw new Error("KAF_VERIFY_MANIFEST_VERSION_UNSUPPORTED");
  const aggregateRecord = record(root.aggregates, "KAF_VERIFY_AGGREGATES_INVALID");
  const aggregates: Record<string, readonly string[]> = {};
  for (const [name, gates] of Object.entries(aggregateRecord)) {
    if (
      !Array.isArray(gates) ||
      gates.some((gate) => typeof gate !== "string" || gate.length === 0)
    ) {
      throw new Error("KAF_VERIFY_GATE_INVALID");
    }
    if (new Set(gates).size !== gates.length) throw new Error("KAF_VERIFY_GATE_DUPLICATE");
    aggregates[name] = gates as readonly string[];
  }
  if (
    !Array.isArray(root.externalGates) ||
    root.externalGates.some((gate) => typeof gate !== "string")
  ) {
    throw new Error("KAF_VERIFY_EXTERNAL_GATES_INVALID");
  }
  if (
    !Array.isArray(root.forbiddenNoOpPatterns) ||
    root.forbiddenNoOpPatterns.some((pattern) => typeof pattern !== "string")
  ) {
    throw new Error("KAF_VERIFY_NOOP_PATTERNS_INVALID");
  }
  return {
    schemaVersion: "1",
    aggregates,
    externalGates: root.externalGates as readonly string[],
    forbiddenNoOpPatterns: root.forbiddenNoOpPatterns as readonly string[],
  };
}

export function verifyGateScripts(
  manifest: VerifyGateManifest,
  scripts: Readonly<Record<string, string>>,
): void {
  const owned = new Map<string, string>();
  for (const [aggregate, gates] of Object.entries(manifest.aggregates)) {
    const aggregateScript = scripts[aggregate];
    if (aggregateScript === undefined) throw new Error(`KAF_VERIFY_SCRIPT_MISSING:${aggregate}`);
    for (const gate of gates) {
      if (owned.has(gate)) throw new Error(`KAF_VERIFY_GATE_OWNERSHIP_DUPLICATE:${gate}`);
      owned.set(gate, aggregate);
      const command = scripts[gate];
      if (command === undefined) throw new Error(`KAF_VERIFY_SCRIPT_MISSING:${gate}`);
      const invocation = new RegExp(
        `(?:^|[&;]\\s*|pnpm\\s+(?:run\\s+)?)${gate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:\\s|$)`,
        "u",
      );
      if (!invocation.test(aggregateScript))
        throw new Error(`KAF_VERIFY_GATE_NOT_IN_AGGREGATE:${aggregate}:${gate}`);
      for (const pattern of manifest.forbiddenNoOpPatterns) {
        if (new RegExp(pattern, "iu").test(command))
          throw new Error(`KAF_VERIFY_GATE_NOOP:${gate}`);
      }
    }
  }
  for (const gate of manifest.externalGates) {
    if (owned.has(gate)) throw new Error(`KAF_VERIFY_EXTERNAL_GATE_AGGREGATED:${gate}`);
    if (scripts[gate] === undefined) throw new Error(`KAF_VERIFY_SCRIPT_MISSING:${gate}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = parseVerifyGateManifest(
    JSON.parse(readFileSync(`${repositoryRoot}/tooling/verify-gates.json`, "utf8")) as unknown,
  );
  const packageManifest = JSON.parse(
    readFileSync(`${repositoryRoot}/package.json`, "utf8"),
  ) as unknown;
  if (
    packageManifest === null ||
    typeof packageManifest !== "object" ||
    !("scripts" in packageManifest) ||
    packageManifest.scripts === null ||
    typeof packageManifest.scripts !== "object" ||
    Array.isArray(packageManifest.scripts)
  ) {
    throw new Error("KAF_VERIFY_PACKAGE_SCRIPTS_INVALID");
  }
  verifyGateScripts(manifest, packageManifest.scripts as Readonly<Record<string, string>>);
  process.stdout.write("Verify gate manifest matches the executable package scripts.\n");
}
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { repositoryRoot } from "./lib/repository.mjs";
