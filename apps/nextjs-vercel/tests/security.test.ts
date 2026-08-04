import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TextPanel } from "../app/components/text-panel";
import { proxy } from "../proxy";
import { EphemeralChallengeVault } from "../src/challenge-vault";

describe("Next UI security boundaries", () => {
  it("renders hostile event, artifact, URL, SVG, and Markdown payloads only as bounded text", () => {
    const hostile = `<script>globalThis.pwned=1</script><svg onload="pwn()"></svg>[x](javascript:alert(1))${String.fromCodePoint(0x202e)}target`;
    const html = renderToStaticMarkup(
      createElement(TextPanel, { title: "Hostile event", value: { hostile }, empty: "empty" }),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("javascript:alert(1)");
    expect(html).toContain("\\u202e");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("href=");
  });

  it("uses a one-use expiring in-memory challenge vault", () => {
    const vault = new EphemeralChallengeVault();
    vault.put("decision", {
      challengeProof: "never-render-this",
      expiresAt: "2026-01-01T00:01:00.000Z",
    });
    expect(vault.has("decision", Date.parse("2026-01-01T00:00:30.000Z"))).toBe(true);
    expect(vault.consume("decision", Date.parse("2026-01-01T00:00:30.000Z"))).toMatchObject({
      challengeProof: "never-render-this",
    });
    expect(vault.consume("decision", Date.parse("2026-01-01T00:00:30.000Z"))).toBeUndefined();
    vault.put("expired", { challengeProof: "expired", expiresAt: "2026-01-01T00:00:00.000Z" });
    expect(vault.consume("expired", Date.parse("2026-01-01T00:00:00.000Z"))).toBeUndefined();
  });

  it("sets strict nonce CSP, anti-clickjacking, and no-store headers", () => {
    const response = proxy(new NextRequest("https://fixture.test/"));
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/u);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("contains no raw HTML or browser persistence escape hatch", async () => {
    const componentPath = fileURLToPath(
      new URL("../app/components/agent-console.tsx", import.meta.url),
    );
    const source = await readFile(componentPath, "utf8");
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toMatch(
      /\b(?:localStorage|sessionStorage|indexedDB|caches|serviceWorker|console\.)\b/u,
    );
    expect(source).not.toContain("challengeProof}</");
  });
});
