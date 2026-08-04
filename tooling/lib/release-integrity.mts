import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseTarSize(field: Uint8Array): number {
  const value = Buffer.from(field).toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error("KAF_RELEASE_TARBALL_INVALID_SIZE");
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("KAF_RELEASE_TARBALL_INVALID_SIZE");
  return size;
}

function tarString(field: Uint8Array): string {
  return Buffer.from(field).toString("utf8").split("\0", 1)[0] ?? "";
}

function verifyTarHeaderChecksum(header: Uint8Array): void {
  const claimed = parseTarSize(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== claimed) throw new Error("KAF_RELEASE_TARBALL_CHECKSUM_MISMATCH");
}

export function readNpmPackedManifest(tarball: Uint8Array): unknown {
  let archive: Buffer;
  try {
    archive = gunzipSync(tarball);
  } catch {
    throw new Error("KAF_RELEASE_TARBALL_INVALID_GZIP");
  }
  let offset = 0;
  let manifest: unknown;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    verifyTarHeaderChecksum(header);
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const size = parseTarSize(header.subarray(124, 136));
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archive.length) throw new Error("KAF_RELEASE_TARBALL_TRUNCATED");
    if (path === "package/package.json") {
      if (manifest !== undefined) throw new Error("KAF_RELEASE_TARBALL_DUPLICATE_MANIFEST");
      try {
        manifest = JSON.parse(archive.subarray(bodyStart, bodyEnd).toString("utf8")) as unknown;
      } catch {
        throw new Error("KAF_RELEASE_TARBALL_INVALID_MANIFEST");
      }
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (manifest === undefined) throw new Error("KAF_RELEASE_TARBALL_MANIFEST_MISSING");
  return manifest;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("KAF_RELEASE_NON_FINITE_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("KAF_RELEASE_NON_JSON_VALUE");
}
