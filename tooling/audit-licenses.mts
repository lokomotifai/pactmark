import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { repositoryRoot } from "./lib/repository.mjs";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, code: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

function packageDirectories(): readonly string[] {
  const virtualStore = join(repositoryRoot, "node_modules", ".pnpm");
  if (!existsSync(virtualStore)) throw new Error("KAF_LICENSE_DEPENDENCIES_NOT_INSTALLED");
  const found = new Set<string>();
  for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const modules = join(virtualStore, entry.name, "node_modules");
    if (!existsSync(modules)) continue;
    for (const name of readdirSync(modules)) {
      if (name.startsWith(".")) continue;
      const candidate = join(modules, name);
      if (name.startsWith("@")) {
        for (const child of readdirSync(candidate)) found.add(join(candidate, child));
      } else {
        found.add(candidate);
      }
    }
  }
  return [...found].sort();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const policy = record(
  JSON.parse(
    readFileSync(join(repositoryRoot, "tooling", "license-policy.json"), "utf8"),
  ) as unknown,
  "KAF_LICENSE_POLICY_INVALID",
);
if (policy["schemaVersion"] !== "1") throw new Error("KAF_LICENSE_POLICY_VERSION_UNSUPPORTED");
const allowed = new Set((policy["allowedExpressions"] as unknown[]).map((value) => String(value)));
const forbidden = (policy["forbiddenTokens"] as unknown[]).map((value) => String(value));
const exceptions = record(policy["manifestExceptions"], "KAF_LICENSE_POLICY_INVALID");
const allowedPackageExpressions = record(
  policy["allowedPackageExpressions"],
  "KAF_LICENSE_POLICY_INVALID",
);
const allowedPackageFamilies = (policy["allowedPackageFamilies"] as unknown[]).map((value) =>
  record(value, "KAF_LICENSE_PACKAGE_FAMILY_INVALID"),
);
const packages = new Map<string, Readonly<{ directory: string; license: unknown }>>();
for (const directory of packageDirectories()) {
  const manifestPath = join(directory, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = record(
    JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    "KAF_LICENSE_MANIFEST_INVALID",
  );
  const name = String(manifest["name"]);
  const version = String(manifest["version"]);
  packages.set(`${name}@${version}`, { directory, license: manifest["license"] });
}

const findings: JsonRecord[] = [];
for (const [identity, entry] of [...packages].sort(([left], [right]) =>
  left.localeCompare(right),
)) {
  const expression = typeof entry.license === "string" ? entry.license : undefined;
  const exceptionValue = exceptions[identity];
  if (expression !== undefined && allowed.has(expression)) continue;
  const packageExpressionValue = allowedPackageExpressions[identity];
  if (packageExpressionValue !== undefined) {
    const packageExpression = record(
      packageExpressionValue,
      "KAF_LICENSE_PACKAGE_EXPRESSION_INVALID",
    );
    if (
      expression === packageExpression["expression"] &&
      typeof packageExpression["reason"] === "string" &&
      packageExpression["reason"].length > 0
    ) {
      continue;
    }
    findings.push({ identity, code: "KAF_LICENSE_PACKAGE_EXPRESSION_DRIFT", expression });
    continue;
  }
  const packageFamilyAccepted = allowedPackageFamilies.some((family) => {
    if (
      typeof family["identityPattern"] !== "string" ||
      typeof family["expression"] !== "string" ||
      typeof family["reason"] !== "string" ||
      family["reason"].length === 0
    ) {
      throw new Error("KAF_LICENSE_PACKAGE_FAMILY_INVALID");
    }
    return (
      new RegExp(family["identityPattern"], "u").test(identity) &&
      expression === family["expression"]
    );
  });
  if (packageFamilyAccepted) continue;
  if (
    expression !== undefined &&
    forbidden.some((token) => expression.toUpperCase().includes(token))
  ) {
    findings.push({ identity, code: "KAF_LICENSE_FORBIDDEN", expression });
    continue;
  }
  if (exceptionValue !== undefined) {
    const exception = record(exceptionValue, "KAF_LICENSE_EXCEPTION_INVALID");
    const licensePath = join(entry.directory, "LICENSE");
    if (
      exception["effectiveLicense"] === "MIT" &&
      typeof exception["reason"] === "string" &&
      existsSync(licensePath) &&
      exception["licenseFileSha256"] === sha256(licensePath)
    ) {
      continue;
    }
    findings.push({ identity, code: "KAF_LICENSE_EXCEPTION_DRIFT" });
    continue;
  }
  findings.push({ identity, code: "KAF_LICENSE_UNREVIEWED", expression: expression ?? null });
}

if (findings.length > 0) {
  process.stderr.write(
    `${JSON.stringify({ code: "KAF_LICENSE_POLICY_FAILED", findings }, null, 2)}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `License policy passed for ${String(packages.size)} installed package versions.\n`,
  );
}
