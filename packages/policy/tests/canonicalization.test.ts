import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  POLICY_NORMALIZATION_VERSION,
  PolicyNormalizationError,
  assertResolvedPathWithinRoot,
  canonicalizeHost,
  canonicalizeIdentifier,
  canonicalizeResourcePath,
  canonicalizeResourceScope,
  canonicalizeTenantNamespace,
  canonicalizeToolArguments,
  canonicalizeUrl,
  isResourceWithinScope,
} from "../src/index.js";

describe("policy canonicalization", () => {
  it("canonicalizes deterministic JSON without rewriting natural-language strings", () => {
    const left = canonicalizeToolArguments({ z: "Cafe\u0301", a: 1 });
    const right = canonicalizeToolArguments({ a: 1, z: "Cafe\u0301" });
    expect(left).toEqual(right);
    expect(left.canonicalJson).toContain("Café");
  });

  it.each([
    "../secret",
    "workspace/../secret",
    "workspace/%2e%2e/secret",
    "workspace/%252e%252e/secret",
    "/etc/passwd",
    "C:/Windows/system.ini",
    "workspace\\secret",
  ])("rejects path ambiguity and traversal: %s", (value) => {
    expect(() => {
      canonicalizeResourcePath(value);
    }).toThrow(PolicyNormalizationError);
  });

  it("checks physical paths supplied by a host without claiming filesystem resolution", () => {
    expect(() => {
      assertResolvedPathWithinRoot("/workspace/docs", "/workspace/private/key");
    }).toThrow(/escapes/u);
    expect(() => {
      assertResolvedPathWithinRoot("/workspace/docs", "/workspace/docs/result.md");
    }).not.toThrow();
    expect(() => {
      assertResolvedPathWithinRoot("workspace/docs", "workspace/docs/result.md");
    }).toThrow(/absolute/u);
  });

  it.each([
    "localhost",
    "127.0.0.1",
    "2130706433",
    "0x7f000001",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "100.64.0.1",
    "224.0.0.1",
    "metadata.google.internal",
    "metadata.azure.internal",
    "printer.local",
    "198.18.0.1",
    "[::1]",
    "[fe80::1]",
    "[::ffff:7f00:1]",
  ])("rejects identifiable private, loopback, link-local, and metadata host %s", (host) => {
    expect(() => canonicalizeHost(host)).toThrow(PolicyNormalizationError);
  });

  it("normalizes public URL host, default port, path, and query ordering", () => {
    expect(canonicalizeUrl("HTTPS://Example.COM:443/api?z=2&a=1")).toBe(
      "https://example.com/api?a=1&z=2",
    );
    expect(canonicalizeUrl("https://[2001:4860:4860::8888]/")).toBe(
      "https://[2001:4860:4860::8888]/",
    );
    expect(() => canonicalizeUrl("https://user:pass@example.com/")).toThrow(/userinfo/u);
    expect(() => canonicalizeUrl("file:///etc/passwd")).toThrow(/HTTP/u);
  });

  it("rejects malformed encodings, controls, ambiguous authorities, fragments, and URL traversal", () => {
    expect(() => canonicalizeIdentifier("Admin")).toThrow(/lowercase/u);
    expect(() => canonicalizeIdentifier("user\u0000name")).toThrow(/Control/u);
    expect(() => canonicalizeResourcePath("workspace/%E0%A4%A")).toThrow(/percent/u);
    expect(() => canonicalizeResourcePath("workspace/%25252525252e")).toThrow(/nested/u);
    expect(() => canonicalizeResourcePath("%2fetc/passwd")).toThrow(/Encoded/u);
    expect(() => canonicalizeHost("")).toThrow(/components/u);
    expect(() => canonicalizeHost("bad host:wat")).toThrow(/ambiguous/u);
    expect(() => canonicalizeHost("example.com:")).toThrow(/components/u);
    expect(() => canonicalizeHost("example..com")).toThrow(/ambiguous/u);
    expect(() => canonicalizeHost("user@example.com")).toThrow(/components/u);
    expect(() => canonicalizeUrl("not a url")).toThrow(/invalid/u);
    expect(() => canonicalizeUrl("https://example.com/path#fragment")).toThrow(/fragments/u);
    expect(() => canonicalizeUrl("https://example.com/%252e%252e/private")).toThrow(/traversal/u);
  });

  it("canonicalizes every supported resource kind and denies unknown or mismatched kinds", () => {
    const version = POLICY_NORMALIZATION_VERSION;
    expect(canonicalizeTenantNamespace("tenant-1")).toBe("tenant-1");
    expect(() => canonicalizeTenantNamespace("tenant/child")).toThrow(/single/u);
    expect(() => canonicalizeTenantNamespace("tenant:child")).toThrow(/single/u);
    expect(canonicalizeHost("example.com:8443")).toBe("example.com:8443");
    expect(
      isResourceWithinScope(
        { kind: "host", value: "example.com", normalizationVersion: version },
        { kind: "identifier", value: "example.com", normalizationVersion: version },
      ),
    ).toBe(false);
    expect(
      isResourceWithinScope(
        { kind: "host", value: "example.com", normalizationVersion: version },
        { kind: "host", value: "example.com", normalizationVersion: version },
      ),
    ).toBe(true);
    expect(
      isResourceWithinScope(
        { kind: "identifier", value: "object-1", normalizationVersion: version },
        { kind: "identifier", value: "object-2", normalizationVersion: version },
      ),
    ).toBe(false);
    expect(
      isResourceWithinScope(
        { kind: "url", value: "https://example.com/api/items", normalizationVersion: version },
        { kind: "url", value: "https://example.com/api", normalizationVersion: version },
      ),
    ).toBe(true);
    expect(
      isResourceWithinScope(
        { kind: "url", value: "https://evil.example/api", normalizationVersion: version },
        { kind: "url", value: "https://example.com/api", normalizationVersion: version },
      ),
    ).toBe(false);
    expect(
      isResourceWithinScope(
        { kind: "path", value: "../escape", normalizationVersion: version },
        { kind: "path", value: "workspace", normalizationVersion: version },
      ),
    ).toBe(false);
    expect(() =>
      canonicalizeResourceScope({
        kind: "unknown",
        value: "x",
        normalizationVersion: version,
      } as never),
    ).toThrow(/Unknown/u);
    for (const scope of [
      { kind: "host", value: "example.com", normalizationVersion: version },
      { kind: "identifier", value: "object-1", normalizationVersion: version },
      { kind: "tenant", value: "tenant-1", normalizationVersion: version },
      { kind: "urn", value: "URN:Pactmark:resource-1", normalizationVersion: version },
    ]) {
      expect(canonicalizeResourceScope(scope)).toMatchObject({ normalizationVersion: version });
    }
  });

  it("never widens path scope and uses exact matching for identifiers", () => {
    const version = POLICY_NORMALIZATION_VERSION;
    expect(
      isResourceWithinScope(
        { kind: "path", value: "workspace/docs/a.md", normalizationVersion: version },
        { kind: "path", value: "workspace/docs", normalizationVersion: version },
      ),
    ).toBe(true);
    expect(
      isResourceWithinScope(
        { kind: "path", value: "workspace/docs-private/a.md", normalizationVersion: version },
        { kind: "path", value: "workspace/docs", normalizationVersion: version },
      ),
    ).toBe(false);
  });

  it("holds path segment safety for 10,000 deterministic generated inputs", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,12}$/u), {
          minLength: 1,
          maxLength: 8,
        }),
        (segments) => {
          const canonical = canonicalizeResourcePath(segments.join("/"));
          return !canonical.startsWith("/") && !canonical.includes("\\");
        },
      ),
      { numRuns: 10_000, seed: 20260803 },
    );
  }, 30_000);

  it("holds identifier idempotence for 10,000 deterministic generated inputs", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z](?:[a-z0-9._-]{0,29}[a-z0-9])?$/u), (identifier) => {
        const once = canonicalizeIdentifier(identifier);
        return canonicalizeIdentifier(once) === once;
      }),
      { numRuns: 10_000, seed: 20260804 },
    );
  });

  it("rejects encoded traversal at every generated path position for 10,000 runs", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,8}$/u), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.integer({ min: 0, max: 6 }),
        fc.constantFrom("..", "%2e%2e", "%252e%252e", "%2E%2E"),
        (segments, rawPosition, attack) => {
          const position = rawPosition % (segments.length + 1);
          const malicious = [...segments];
          malicious.splice(position, 0, attack);
          try {
            canonicalizeResourcePath(malicious.join("/"));
            return false;
          } catch (error) {
            return error instanceof PolicyNormalizationError;
          }
        },
      ),
      { numRuns: 10_000, seed: 20260805 },
    );
  }, 30_000);

  it("rejects generated private and link-local IPv4 hosts for 10,000 runs", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.tuple(fc.constant(10), fc.integer({ min: 0, max: 255 })),
          fc.tuple(fc.constant(127), fc.integer({ min: 0, max: 255 })),
          fc.tuple(fc.constant(169), fc.constant(254)),
          fc.tuple(fc.constant(192), fc.constant(168)),
          fc.tuple(fc.integer({ min: 172, max: 172 }), fc.integer({ min: 16, max: 31 })),
        ),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        ([first, second], third, fourth) => {
          try {
            canonicalizeHost(
              `${String(first)}.${String(second)}.${String(third)}.${String(fourth)}`,
            );
            return false;
          } catch (error) {
            return error instanceof PolicyNormalizationError;
          }
        },
      ),
      { numRuns: 10_000, seed: 20260806 },
    );
  }, 30_000);

  it("never widens generated URL path scope over 10,000 deterministic runs", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,8}$/u),
        fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,8}$/u),
        (parentSegment, siblingSuffix) => {
          const version = POLICY_NORMALIZATION_VERSION;
          return !isResourceWithinScope(
            {
              kind: "url",
              value: `https://example.com/${parentSegment}-${siblingSuffix}/item`,
              normalizationVersion: version,
            },
            {
              kind: "url",
              value: `https://example.com/${parentSegment}`,
              normalizationVersion: version,
            },
          );
        },
      ),
      { numRuns: 10_000, seed: 20260807 },
    );
  }, 30_000);
});
