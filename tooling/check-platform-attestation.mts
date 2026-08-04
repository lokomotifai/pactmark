import { readFileSync } from "node:fs";

const path = process.env["PACTMARK_PLATFORM_ATTESTATION"];
if (path === undefined) throw new Error("KAF_PLATFORM_ATTESTATION_REQUIRED");
const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
const checks =
  value !== null && typeof value === "object" && "checks" in value && Array.isArray(value.checks)
    ? (value.checks as unknown[])
    : undefined;
if (
  value === null ||
  typeof value !== "object" ||
  !("schemaVersion" in value) ||
  value.schemaVersion !== "1" ||
  !("authorized" in value) ||
  value.authorized !== true ||
  !("sourceDigest" in value) ||
  typeof value.sourceDigest !== "string" ||
  checks === undefined ||
  checks.length === 0 ||
  checks.some(
    (check) =>
      check === null ||
      typeof check !== "object" ||
      !("status" in check) ||
      check.status !== "pass",
  )
) {
  throw new Error("KAF_PLATFORM_ATTESTATION_INVALID");
}
process.stdout.write(`${JSON.stringify({ status: "verified", path })}\n`);
