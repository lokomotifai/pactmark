import {
  canonicalJsonStringify,
  digestCanonicalJson,
  type Digest,
  type JsonValue,
  type ResourceScope,
} from "@pactmark/core";
import { z } from "zod";

export const POLICY_NORMALIZATION_VERSION = "pactmark.policy-normalization@1" as const;

export class PolicyNormalizationError extends TypeError {
  readonly code = "KAF_POLICY_SCOPE_DENIED" as const;

  constructor(readonly reason: string) {
    super(reason);
    this.name = "PolicyNormalizationError";
  }
}

function rejectControls(value: string): void {
  if (/\p{Cc}|\p{Cf}/u.test(value)) {
    throw new PolicyNormalizationError("Control and format characters are not permitted");
  }
}

function normalizedText(value: string): string {
  const normalized = value.normalize("NFC");
  rejectControls(normalized);
  return normalized;
}

export function canonicalizeIdentifier(value: string): string {
  const normalized = normalizedText(value).trim();
  if (!/^[a-z0-9](?:[a-z0-9._:@/-]{0,254}[a-z0-9])?$/u.test(normalized)) {
    throw new PolicyNormalizationError("Identifier is not in canonical lowercase form");
  }
  return normalized;
}

export function canonicalizeTenantNamespace(value: string): string {
  const normalized = canonicalizeIdentifier(value);
  if (normalized.includes("/") || normalized.includes(":")) {
    throw new PolicyNormalizationError("Tenant namespace must be a single identifier segment");
  }
  return normalized;
}

function repeatedlyDecode(value: string): string {
  let current = value;
  for (let index = 0; index < 4; index += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      throw new PolicyNormalizationError("Malformed percent encoding");
    }
    if (next === current) return current;
    current = next;
  }
  throw new PolicyNormalizationError("Excessively nested percent encoding");
}

export function canonicalizeResourcePath(value: string): string {
  const normalized = normalizedText(value);
  if (normalized.includes("\\") || normalized.startsWith("/") || /^[a-zA-Z]:/u.test(normalized)) {
    throw new PolicyNormalizationError("Only package-relative slash-separated paths are permitted");
  }
  const decoded = repeatedlyDecode(normalized);
  if (decoded.includes("\\") || decoded.startsWith("/")) {
    throw new PolicyNormalizationError("Encoded absolute or backslash path is not permitted");
  }
  const segments = decoded.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new PolicyNormalizationError("Path traversal or ambiguous path segment is not permitted");
  }
  for (const segment of segments) rejectControls(segment);
  return segments.join("/");
}

export function assertNoSymlinkEscape(root: string, physicallyResolvedPath: string): void {
  const canonicalRoot = canonicalizeResourcePath(root);
  const canonicalResolved = canonicalizeResourcePath(physicallyResolvedPath);
  if (canonicalResolved !== canonicalRoot && !canonicalResolved.startsWith(`${canonicalRoot}/`)) {
    throw new PolicyNormalizationError("Resolved path escapes the authorized root");
  }
}

function parseIpv4(host: string): readonly number[] | undefined {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return undefined;
  const octets = host.split(".").map(Number);
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : undefined;
}

function isBlockedIpv4(octets: readonly number[]): boolean {
  const [a = -1, b = -1] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export function canonicalizeHost(value: string): string {
  const raw = normalizedText(value).trim().toLowerCase();
  if (
    raw === "" ||
    raw.endsWith(":") ||
    raw.includes("@") ||
    raw.includes("/") ||
    raw.includes("?") ||
    raw.includes("#")
  ) {
    throw new PolicyNormalizationError("Host is empty or contains URL components");
  }
  let url: URL;
  try {
    url = new URL(`https://${raw}/`);
  } catch {
    throw new PolicyNormalizationError("Host or port is ambiguous");
  }
  if (url.username !== "" || url.password !== "" || url.pathname !== "/") {
    throw new PolicyNormalizationError("Host authority is ambiguous");
  }
  const host = url.hostname
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  if (
    host.startsWith(".") ||
    host.includes("..") ||
    (!host.includes(":") && !/^[a-z0-9.-]+$/u.test(host))
  ) {
    throw new PolicyNormalizationError("Host name is ambiguous or non-canonical");
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    host === "metadata.azure.internal"
  ) {
    throw new PolicyNormalizationError("Loopback or metadata host is denied");
  }
  const ipv4 = parseIpv4(host);
  if (ipv4 !== undefined && isBlockedIpv4(ipv4)) {
    throw new PolicyNormalizationError(
      "Private, reserved, loopback, or link-local address is denied",
    );
  }
  const compactIpv6 = host.replace(/^0+|:0+(?=[0-9a-f])/gu, "");
  if (
    host.includes(":") &&
    (host === "::" ||
      host === "::1" ||
      /^f[cd][0-9a-f]{2}:/u.test(host) ||
      /^fe[89ab][0-9a-f]:/u.test(host) ||
      host.startsWith("::ffff:") ||
      compactIpv6.includes("::ffff:127.") ||
      compactIpv6.includes("::ffff:10.") ||
      compactIpv6.includes("::ffff:169.254."))
  ) {
    throw new PolicyNormalizationError("Private, mapped, loopback, or link-local IPv6 is denied");
  }
  const port = url.port;
  return port === "" ? host : `${host}:${port}`;
}

export function canonicalizeUrl(value: string): string {
  const normalized = normalizedText(value);
  const authorityEnd = normalized.search(/[/?#]/u);
  const pathStart = normalized.indexOf("/", authorityEnd < 0 ? normalized.length : authorityEnd);
  if (pathStart >= 0) {
    const rawPath = normalized.slice(pathStart).split(/[?#]/u, 1)[0] ?? "";
    for (const rawSegment of rawPath.split("/")) {
      const decoded = repeatedlyDecode(rawSegment);
      if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
        throw new PolicyNormalizationError(
          "URL path traversal or encoded separator is not permitted",
        );
      }
    }
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new PolicyNormalizationError("URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PolicyNormalizationError("Only HTTP(S) URLs are supported");
  }
  if (url.username !== "" || url.password !== "") {
    throw new PolicyNormalizationError("URL userinfo is not permitted");
  }
  if (url.hash !== "") throw new PolicyNormalizationError("URL fragments are not policy resources");
  const hostname = canonicalizeHost(url.hostname);
  const pathname = url.pathname
    .split("/")
    .map((segment) => repeatedlyDecode(segment))
    .join("/");
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new PolicyNormalizationError("URL path traversal is not permitted");
  }
  url.hostname = hostname.includes(":") ? `[${hostname}]` : hostname;
  url.searchParams.sort();
  return url.toString();
}

export function canonicalizeToolArguments(value: unknown): {
  readonly canonicalJson: string;
  readonly digest: Digest;
} {
  const parsed = z.json().parse(value) as JsonValue;
  return Object.freeze({
    canonicalJson: canonicalJsonStringify(parsed),
    digest: digestCanonicalJson(parsed),
  });
}

export function canonicalizeResourceScope(scope: ResourceScope): ResourceScope {
  const value = (() => {
    switch (scope.kind) {
      case "path":
        return canonicalizeResourcePath(scope.value);
      case "url":
        return canonicalizeUrl(scope.value);
      case "host":
        return canonicalizeHost(scope.value);
      case "identifier":
        return canonicalizeIdentifier(scope.value);
      case "tenant":
        return canonicalizeTenantNamespace(scope.value);
      default:
        throw new PolicyNormalizationError("Unknown resource kind");
    }
  })();
  return Object.freeze({
    kind: scope.kind,
    value,
    normalizationVersion: POLICY_NORMALIZATION_VERSION,
  });
}

export function isResourceWithinScope(candidate: ResourceScope, ceiling: ResourceScope): boolean {
  if (candidate.kind !== ceiling.kind) return false;
  let child: ResourceScope;
  let parent: ResourceScope;
  try {
    child = canonicalizeResourceScope(candidate);
    parent = canonicalizeResourceScope(ceiling);
  } catch {
    return false;
  }
  if (child.kind === "path") {
    return child.value === parent.value || child.value.startsWith(`${parent.value}/`);
  }
  if (child.kind === "url") {
    const childUrl = new URL(child.value);
    const parentUrl = new URL(parent.value);
    return (
      childUrl.origin === parentUrl.origin &&
      childUrl.search === parentUrl.search &&
      (childUrl.pathname === parentUrl.pathname ||
        childUrl.pathname.startsWith(`${parentUrl.pathname.replace(/\/$/u, "")}/`))
    );
  }
  return child.value === parent.value;
}
