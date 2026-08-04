import { evaluatePurchaseBoundary } from "./example.js";

console.log(
  JSON.stringify(
    evaluatePurchaseBoundary({
      sku: "P-100",
      quantity: 2,
      unitPriceMinor: 1250,
      currency: "USD",
      targetAccount: "DEMO-MERCHANT",
    }),
  ),
);
