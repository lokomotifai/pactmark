import { runPurchaseDecision } from "./example.js";

console.log(
  JSON.stringify(
    await runPurchaseDecision(
      {
        sku: "P-100",
        quantity: 2,
        unitPriceMinor: 1250,
        currency: "USD",
        targetAccount: "DEMO-MERCHANT",
      },
      "approve",
    ),
  ),
);
