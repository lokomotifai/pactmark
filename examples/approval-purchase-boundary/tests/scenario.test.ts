import { describe, expect, it } from "vitest";
import { evaluatePurchaseBoundary, observedDispatchCount } from "../src/example.js";

describe("approval boundary", () => {
  it("binds the exact preview and performs zero external writes", () => {
    const result = evaluatePurchaseBoundary({
      sku: "P-100",
      quantity: 2,
      unitPriceMinor: 1250,
      currency: "USD",
      targetAccount: " Demo-Merchant ",
    });
    expect(result).toMatchObject({
      status: "blocked",
      code: "KAF_EXAMPLE_APPROVAL_SURFACE_UNAVAILABLE",
      dispatchCount: 0,
      productionClaim: false,
    });
    expect(result.preview.normalizedTarget).toBe("demo-merchant");
    expect(result.preview.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(observedDispatchCount()).toBe(0);
  });

  it("rejects malformed price authority before preview", () => {
    expect(() =>
      evaluatePurchaseBoundary({
        sku: "P-100",
        quantity: 0,
        unitPriceMinor: 1,
        currency: "USD",
        targetAccount: "merchant",
      }),
    ).toThrow("KAF_EXAMPLE_PURCHASE_QUANTITY_INVALID");
  });
});
