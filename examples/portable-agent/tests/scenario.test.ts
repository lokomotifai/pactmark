import { describe, expect, it } from "vitest";
import { handleCloudflare } from "../src/entrypoints/cloudflare.js";
import { handleNode } from "../src/entrypoints/node.js";
import { handleVercel } from "../src/entrypoints/vercel.js";
import { verifyPortableResult } from "../src/verifiers/result.js";

describe("portable agent host contract", () => {
  it("produces the same normalized contract on every host", async () => {
    const results = await Promise.all([
      handleNode({ sku: "P-100" }),
      handleVercel({ sku: "P-100" }),
      handleCloudflare({ sku: "P-100" }),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    const first = results[0];
    expect(first.ok).toBe(true);
    if (first.ok) expect(verifyPortableResult(first)).toBe(true);
  });
  it("keeps stable error codes across hosts", async () => {
    const results = await Promise.all([
      handleNode({ sku: "missing" }),
      handleVercel({ sku: "missing" }),
      handleCloudflare({ sku: "missing" }),
    ]);
    expect(results).toEqual(
      Array.from({ length: 3 }, () => ({ ok: false, errorCode: "KAF_EXAMPLE_SKU_NOT_FOUND" })),
    );
  });
});
