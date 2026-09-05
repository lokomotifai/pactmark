import { describe, expect, it } from "vitest";
import cloudflareWorker from "../src/entrypoints/cloudflare.js";
import { handleNode } from "../src/entrypoints/node.js";
import { POST as handleVercelPost } from "../src/entrypoints/vercel.js";
import { verifyPortableResult } from "../src/verifiers/result.js";

describe("portable agent host contract", () => {
  it("produces the same normalized contract on every host", async () => {
    const request = () =>
      new Request("https://fixture.invalid/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku: "P-100" }),
      });
    const vercel = await handleVercelPost(request());
    const cloudflare = await cloudflareWorker.fetch(request());
    expect(vercel.status).toBe(200);
    expect(cloudflare.status).toBe(200);
    const results = await Promise.all([
      handleNode({ sku: "P-100" }),
      vercel.json(),
      cloudflare.json(),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    const first = results[0];
    expect(first.ok).toBe(true);
    if (first.ok) expect(verifyPortableResult(first)).toBe(true);
  });
  it("keeps stable error codes across hosts", async () => {
    const request = () =>
      new Request("https://fixture.invalid/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku: "missing" }),
      });
    const vercel = await handleVercelPost(request());
    const cloudflare = await cloudflareWorker.fetch(request());
    expect(vercel.status).toBe(400);
    expect(cloudflare.status).toBe(400);
    const results = await Promise.all([
      handleNode({ sku: "missing" }),
      vercel.json(),
      cloudflare.json(),
    ]);
    expect(results).toEqual(
      Array.from({ length: 3 }, () => ({ ok: false, errorCode: "KAF_EXAMPLE_SKU_NOT_FOUND" })),
    );
  });
});
